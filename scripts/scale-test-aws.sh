#!/usr/bin/env bash
#
# Mehfil mesh scale test on an AWS spot box — the whole routine, repeatable.
#
# The overlay is in-process loopback WebRTC, so N peers = N headless Chromium
# contexts on ONE machine. A laptop saturates around 10-15 contexts and the
# failures then look like overlay bugs but are really CPU starvation (see
# plan/aws-scale-test-plan.md). A 16-vCPU box gives clean signal at N=30.
#
#   ./scale-test-aws.sh preflight     # read-only: creds, posture, orphans. Free.
#   ./scale-test-aws.sh run           # full cycle: up -> test -> teardown
#   ./scale-test-aws.sh run --netem   # same, under 20ms±5ms delay + 1% loss
#   ./scale-test-aws.sh down          # force teardown (safe to re-run)
#   ./scale-test-aws.sh status        # what's alive right now
#
#   N_LIST="10 20 30"   which peer counts to run, in order
#   REGION=us-east-1    eu-south-2 is the documented clean fallback
#   KEEP=1              don't tear down (debugging) — YOU must run `down` after
#
# Costs cents (c6i.4xlarge spot ~$0.22/hr, run is ~20 min). Teardown is in a
# trap and also idempotent, because the expensive mistake here is a forgotten
# box, not a failed test.
#
# Access is SSM only — no SSH, no inbound rules, no key pairs. The box needs no
# ingress at all; the SSM agent dials out.
#
set -euo pipefail

PROFILE="${AWS_PROFILE:-admin-cli}"
REGION="${REGION:-us-east-1}"
# Spot capacity for any single type runs out regularly — the first attempt at
# this run died on InsufficientInstanceCapacity for c6i.4xlarge. All of these
# are 16 vCPU / 32 GB, which is what N=30 needs; the test doesn't care which.
# Set ON_DEMAND=1 to fall back to on-demand if every spot type is dry (~3x the
# price, still well under a dollar for a 20-minute run).
INSTANCE_TYPES="${INSTANCE_TYPES:-c6i.4xlarge c7i.4xlarge c6a.4xlarge m6i.4xlarge c5.4xlarge m5.4xlarge}"
ON_DEMAND="${ON_DEMAND:-1}"
N_LIST="${N_LIST:-10 20 30}"
TAG_KEY="mehfil-scale"          # cost allocation AND the IAM destructive-gate
TAG_VAL="true"
STAMP="$(date +%Y%m%d-%H%M%S)"
NAME="mehfil-scale-$STAMP"
KEEP="${KEEP:-0}"
NETEM=0
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"

aws() { command aws --profile "$PROFILE" --region "$REGION" "$@"; }
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die() { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# State we must restore. Recorded at `up`, consumed at `down`.
STATE="$WORK/state.env"
[ -f /tmp/mehfil-scale-state.env ] && STATE=/tmp/mehfil-scale-state.env
remember() { echo "$1=$2" >> "$STATE"; }
recall() { [ -f "$STATE" ] && grep -m1 "^$1=" "$STATE" 2>/dev/null | cut -d= -f2- || true; }

# ---------------------------------------------------------------- preflight

preflight() {
  say "Pre-flight (read-only, spends nothing)"

  local who
  who=$(aws sts get-caller-identity --query Arn --output text) \
    || die "no AWS creds for profile '$PROFILE'"
  info "identity: $who"

  # The gotcha that eats an afternoon: a region's default VPC can have an IGW
  # that is DETACHED but still named by the main route table's 0.0.0.0/0. The
  # route state reads `blackhole`, instances launch fine with public IPs, and
  # nothing can reach them — including the SSM agent, so the box never checks
  # in and the whole run dies looking like a timeout.
  local vpc route_state igw
  vpc=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true \
          --query 'Vpcs[0].VpcId' --output text)
  [ "$vpc" != "None" ] || die "no default VPC in $REGION"
  read -r route_state igw < <(aws ec2 describe-route-tables \
    --filters Name=vpc-id,Values="$vpc" Name=association.main,Values=true \
    --query 'RouteTables[].Routes[?DestinationCidrBlock==`0.0.0.0/0`].[State,GatewayId]' \
    --output text | head -1)
  info "default vpc: $vpc"
  info "0.0.0.0/0 route: $route_state via ${igw:-none}"
  if [ "$route_state" = "blackhole" ]; then
    info "  -> IGW is detached. 'up' will attach it for the run and DETACH it again"
    info "     at teardown, so the account's posture is left exactly as found."
  fi

  local running
  running=$(aws ec2 describe-instances \
    --filters Name=instance-state-name,Values=running,pending \
    --query 'length(Reservations[].Instances[])' --output text)
  info "instances already running in $REGION: $running"
  [ "$running" = "0" ] || info "  -> NOT ours necessarily; 'status' lists tagged ones only"

  info "spot price now:"
  aws ec2 describe-spot-price-history --instance-types ${INSTANCE_TYPES%% *} \
    --product-descriptions "Linux/UNIX" --max-items 1 \
    --query 'SpotPriceHistory[0].[AvailabilityZone,SpotPrice]' --output text \
    | sed 's/^/      /' || info "      (unavailable)"

  say "Pre-flight OK"
}

# ------------------------------------------------------------------- stage

# The box needs the app + harness. The repo is public, but we deliberately test
# whatever is in THIS working tree (usually an unmerged branch), so ship a
# tarball rather than cloning. S3 + a presigned URL means the instance needs no
# S3 permissions of its own.
stage() {
  say "Staging working tree -> S3"
  local bucket="mehfil-scale-$STAMP-$RANDOM"
  local tar="$WORK/mehfil.tgz"
  local extra=""

  # compare mode also ships a second index.html from BASELINE_REF, so both
  # versions can be measured on the SAME box in the same conditions. Overlay
  # convergence varies a lot run to run; comparing a number from today's box
  # against one written down from a different box on a different day is how
  # you end up blaming a code change for an environment difference.
  if [ -n "${BASELINE_REF:-}" ]; then
    git -C "$REPO_ROOT" show "$BASELINE_REF:index.html" > "$REPO_ROOT/.baseline.html"
    extra=".baseline.html"
    info "baseline: $BASELINE_REF -> .baseline.html"
  fi

  tar -C "$REPO_ROOT" -czf "$tar" \
    index.html sw.js manifest.json $extra \
    scripts/verify-mesh.mjs scripts/verify-mesh-scale.mjs \
    scripts/verify-journeys.mjs scripts/package.json
  [ -n "$extra" ] && rm -f "$REPO_ROOT/.baseline.html"
  info "tarball: $(du -h "$tar" | cut -f1)"

  aws s3api create-bucket --bucket "$bucket" \
    $([ "$REGION" = us-east-1 ] || echo --create-bucket-configuration "LocationConstraint=$REGION") \
    >/dev/null
  remember BUCKET "$bucket"
  aws s3 cp "$tar" "s3://$bucket/mehfil.tgz" >/dev/null
  PRESIGNED=$(aws s3 presign "s3://$bucket/mehfil.tgz" --expires-in 3600)
  info "staged to s3://$bucket (presigned, 1h)"
}

# ---------------------------------------------------------------------- up

up() {
  preflight
  stage
  say "Provisioning a 16-vCPU box in $REGION (spot, with fallbacks)"

  local vpc route_state igw
  vpc=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
  read -r route_state igw < <(aws ec2 describe-route-tables \
    --filters Name=vpc-id,Values="$vpc" Name=association.main,Values=true \
    --query 'RouteTables[].Routes[?DestinationCidrBlock==`0.0.0.0/0`].[State,GatewayId]' \
    --output text | head -1)

  if [ "$route_state" = "blackhole" ] && [ -n "$igw" ]; then
    info "attaching $igw to $vpc for this run (will detach at teardown)"
    aws ec2 attach-internet-gateway --internet-gateway-id "$igw" --vpc-id "$vpc"
    remember IGW_TO_DETACH "$igw"
    remember IGW_VPC "$vpc"
    sleep 5
  fi

  # SSM-only: egress for the agent, zero ingress.
  local sg
  sg=$(aws ec2 create-security-group --group-name "$NAME" \
        --description "Mehfil scale test (SSM only, no ingress)" \
        --vpc-id "$vpc" --query GroupId --output text)
  remember SG "$sg"
  aws ec2 create-tags --resources "$sg" --tags "Key=$TAG_KEY,Value=$TAG_VAL" "Key=Name,Value=$NAME"
  info "security group: $sg (no inbound rules)"

  # Instance profile so SSM can reach the box without SSH.
  local role="$NAME-role"
  command aws --profile "$PROFILE" iam create-role --role-name "$role" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
    --tags "Key=$TAG_KEY,Value=$TAG_VAL" >/dev/null
  remember ROLE "$role"
  command aws --profile "$PROFILE" iam attach-role-policy --role-name "$role" \
    --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  command aws --profile "$PROFILE" iam create-instance-profile --instance-profile-name "$role" >/dev/null
  command aws --profile "$PROFILE" iam add-role-to-instance-profile \
    --instance-profile-name "$role" --role-name "$role"
  info "instance profile: $role (waiting for IAM propagation)"
  sleep 15

  local ami
  ami=$(aws ssm get-parameters \
    --names /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
    --query 'Parameters[0].Value' --output text)
  info "ami: $ami (ubuntu 24.04)"

  # Walk the type ladder until something has capacity. Only capacity errors
  # advance the ladder — anything else is a real failure and should surface.
  local iid="" try err
  for try in $INSTANCE_TYPES; do
    info "trying spot $try"
    if err=$(aws ec2 run-instances \
        --image-id "$ami" --instance-type "$try" \
        --security-group-ids "$sg" \
        --iam-instance-profile "Name=$role" \
        --instance-market-options 'MarketType=spot,SpotOptions={SpotInstanceType=one-time}' \
        --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=30,VolumeType=gp3,DeleteOnTermination=true}' \
        --tag-specifications "ResourceType=instance,Tags=[{Key=$TAG_KEY,Value=$TAG_VAL},{Key=Name,Value=$NAME}]" \
        --metadata-options 'HttpTokens=required,HttpEndpoint=enabled' \
        --query 'Instances[0].InstanceId' --output text 2>&1); then
      iid="$err"; INSTANCE_TYPE="$try"
      info "got spot $try"
      break
    fi
    case "$err" in
      *InsufficientInstanceCapacity*|*SpotMaxPriceTooLow*|*Unsupported*)
        info "  no spot capacity for $try, next" ;;
      *) die "run-instances failed: $err" ;;
    esac
  done

  if [ -z "$iid" ] && [ "$ON_DEMAND" = "1" ]; then
    info "every spot type was dry — falling back to on-demand $INSTANCE_TYPE"
    iid=$(aws ec2 run-instances \
      --image-id "$ami" --instance-type "${INSTANCE_TYPES%% *}" \
      --security-group-ids "$sg" \
      --iam-instance-profile "Name=$role" \
      --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=30,VolumeType=gp3,DeleteOnTermination=true}' \
      --tag-specifications "ResourceType=instance,Tags=[{Key=$TAG_KEY,Value=$TAG_VAL},{Key=Name,Value=$NAME}]" \
      --metadata-options 'HttpTokens=required,HttpEndpoint=enabled' \
      --query 'Instances[0].InstanceId' --output text)
  fi
  [ -n "$iid" ] || die "no capacity on any type, and ON_DEMAND=0"
  remember INSTANCE "$iid"
  info "instance: $iid — waiting for it to run"
  aws ec2 wait instance-running --instance-ids "$iid"

  info "waiting for SSM to register the box (this is where a blackholed IGW shows up)"
  local n=0
  until [ "$(aws ssm describe-instance-information \
              --filters "Key=InstanceIds,Values=$iid" \
              --query 'length(InstanceInformationList)' --output text)" = "1" ]; do
    n=$((n+1))
    [ "$n" -lt 40 ] || die "SSM never registered $iid — check the 0.0.0.0/0 route state"
    sleep 15
  done
  say "Box is up and reachable: $iid"
}

# --------------------------------------------------------------------- run

# Fire-and-poll: SSM send-command, then wait for it, then print the output.
#
# The parameters go via a JSON FILE, with the script split into one array
# element per line. Do not be tempted back to the `commands=[...]` shorthand:
# its parser strips the backslash out of the \n escapes, so a script arrives
# with its lines welded together ("...\nset -eux" becomes "nset -eux") and
# fails with a syntax error that looks nothing like the cause.
ssm_run() {
  local label="$1" timeout="$2"; shift 2
  local script="$*" iid cid params="$WORK/params-$RANDOM.json"
  iid=$(recall INSTANCE)
  python3 -c 'import json,sys; print(json.dumps({"commands": sys.stdin.read().split(chr(10))}))' \
    <<< "$script" > "$params"
  cid=$(aws ssm send-command --instance-ids "$iid" \
        --document-name AWS-RunShellScript \
        --comment "$label" \
        --timeout-seconds "$timeout" \
        --parameters "file://$params" \
        --query 'Command.CommandId' --output text)
  info "[$label] command $cid"
  local st
  while :; do
    st=$(aws ssm get-command-invocation --command-id "$cid" --instance-id "$iid" \
          --query Status --output text 2>/dev/null || echo Pending)
    case "$st" in
      Success|Failed|TimedOut|Cancelled) break ;;
    esac
    sleep 10
  done
  aws ssm get-command-invocation --command-id "$cid" --instance-id "$iid" \
    --query StandardOutputContent --output text
  if [ "$st" != "Success" ]; then
    aws ssm get-command-invocation --command-id "$cid" --instance-id "$iid" \
      --query StandardErrorContent --output text >&2
    # Callers that want to keep going check the return code; the ones that
    # can't continue (setup, staging) let `set -e` turn this into an exit.
    return 1
  fi
}

provision_box() {
  say "Installing Node + Chromium on the box"
  ssm_run setup 1800 '
set -eux
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y -qq nodejs
mkdir -p /opt/mehfil && cd /opt/mehfil
curl -fsSL "'"$PRESIGNED"'" -o mehfil.tgz
tar xzf mehfil.tgz
cd scripts && npm install --silent
npx playwright install --with-deps chromium
node -v && echo SETUP_OK
'
}

apply_netem() {
  say "Applying netem (20ms +/-5ms delay, 1% loss) to loopback"
  # netem on lo hits the app's WebRTC + HTTP but NOT Playwright's CDP pipe,
  # so this stresses the app, not the harness.
  ssm_run netem 300 '
set -eux
apt-get install -y -qq iproute2
tc qdisc replace dev lo root netem delay 20ms 5ms loss 1%
tc qdisc show dev lo
'
}

run_tests() {
  local results="$REPO_ROOT/plan/scale-results-$STAMP.txt"
  local red=0
  : > "$results"
  for n in $N_LIST; do
    say "Running the mesh scale harness at N=$n"
    # Capture the harness's exit code explicitly rather than piping into
    # tail, whose status would mask it — a run with six failed assertions
    # used to exit 0. Do NOT reach for `set -o pipefail` here: SSM's
    # AWS-RunShellScript runs through /bin/sh (dash on Ubuntu), which
    # rejects it outright, and every stage dies before a test runs.
    # And it must be `|| rc=$?`, NOT `; rc=$?`: with `set -e` the plain form
    # aborts the moment the harness exits non-zero, so tail never runs and a
    # red stage reports no output at all — you learn that it failed but not
    # what failed.
    #
    # Timeout scales with N: the harness's convergence budget is 15s + N*2.5s,
    # and under netem N=24 took ~38s to converge, so give it real room.
    if ssm_run "scale-N$n" 3600 "
set -eu
cd /opt/mehfil/scripts
rc=0
N=$n CONVERGE_TIMEOUT_MS=$((60000 + n * 6000)) node verify-mesh-scale.mjs > /tmp/h.log 2>&1 || rc=\$?
tail -40 /tmp/h.log
exit \$rc
" | tee -a "$results"; then :; else
      red=$((red+1)); info "N=$n went RED (continuing — the rest of the sweep is still informative)"
    fi
  done

  say "Running the multi-actor journeys"
  if ssm_run journeys 1800 '
set -eu
cd /opt/mehfil/scripts
rc=0
node verify-journeys.mjs > /tmp/j.log 2>&1 || rc=$?
tail -30 /tmp/j.log
exit $rc
' | tee -a "$results"; then :; else
    red=$((red+1)); info "journeys went RED"
  fi

  say "Results saved to $results"
  if [ "$red" -gt 0 ]; then
    info "$red stage(s) RED — see above. Overlay convergence is genuinely flaky run to"
    info "run (a peer occasionally strands at degree 1), so re-run or use \`compare\`"
    info "against a baseline before concluding a code change caused it."
    RUN_RED=1
  fi
}

# -------------------------------------------------------------------- down

# A/B the current tree against a baseline commit, on ONE box, interleaved.
#
# Overlay convergence is not deterministic: the same build at the same N can
# converge in 2.5s or strand a peer at degree 1. So a single run proves very
# little, and comparing today's number against one written down from another
# box on another day proves less. This runs REPS of each version, alternating,
# and prints both series so the question "did my change break the overlay?"
# is answered by two distributions rather than two anecdotes.
compare() {
  local reps="${REPS:-5}" n="${CMP_N:-10}"
  local out="$REPO_ROOT/plan/scale-compare-$STAMP.txt"
  : > "$out"
  say "A/B at N=$n, $reps reps each, interleaved (baseline=$BASELINE_REF)"

  # The harness serves ./index.html by name, so the variant is selected by
  # swapping that file — pristine copies of both are kept beside it.
  ssm_run cmp-init 300 '
set -eu
cd /opt/mehfil
[ -f .head.html ] || cp index.html .head.html
ls -la .head.html .baseline.html
' >/dev/null

  for i in $(seq 1 "$reps"); do
    for variant in baseline head; do
      local src=".head.html"
      [ "$variant" = baseline ] && src=".baseline.html"
      info "rep $i/$reps — $variant"
      ssm_run "cmp-$variant-$i" 1800 "
set -eu
cd /opt/mehfil
cp $src index.html
cd scripts
N=$n CONVERGE_TIMEOUT_MS=$((60000 + n * 6000)) \
  node verify-mesh-scale.mjs 2>&1 | grep -E 'METRICS|PASS -|FAIL -' | tail -3
" | sed "s/^/[$variant rep$i] /" | tee -a "$out"
    done
  done
  say "A/B written to $out"
  echo ""
  info "baseline convergedMs:"; grep '\[baseline' "$out" | grep -o '"convergedMs":[0-9]*' | cut -d: -f2 | tr '\n' ' '; echo
  info "head     convergedMs:"; grep '\[head'     "$out" | grep -o '"convergedMs":[0-9]*' | cut -d: -f2 | tr '\n' ' '; echo
  info "baseline failures:  "; grep '\[baseline' "$out" | grep -o '"failures":[0-9]*' | cut -d: -f2 | tr '\n' ' '; echo
  info "head     failures:  "; grep '\[head'     "$out" | grep -o '"failures":[0-9]*' | cut -d: -f2 | tr '\n' ' '; echo
}

down() {
  say "Teardown (idempotent — safe to re-run)"
  local iid sg role bucket igw vpc
  iid=$(recall INSTANCE); sg=$(recall SG); role=$(recall ROLE)
  bucket=$(recall BUCKET); igw=$(recall IGW_TO_DETACH); vpc=$(recall IGW_VPC)

  if [ -n "$iid" ]; then
    info "terminating $iid"
    aws ec2 terminate-instances --instance-ids "$iid" >/dev/null 2>&1 || true
    aws ec2 wait instance-terminated --instance-ids "$iid" 2>/dev/null || true
  fi
  if [ -n "$bucket" ]; then
    info "removing s3://$bucket"
    aws s3 rm "s3://$bucket" --recursive >/dev/null 2>&1 || true
    aws s3api delete-bucket --bucket "$bucket" >/dev/null 2>&1 || true
  fi
  if [ -n "$role" ]; then
    info "removing iam role/profile $role"
    command aws --profile "$PROFILE" iam remove-role-from-instance-profile \
      --instance-profile-name "$role" --role-name "$role" >/dev/null 2>&1 || true
    command aws --profile "$PROFILE" iam delete-instance-profile \
      --instance-profile-name "$role" >/dev/null 2>&1 || true
    command aws --profile "$PROFILE" iam detach-role-policy --role-name "$role" \
      --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore >/dev/null 2>&1 || true
    command aws --profile "$PROFILE" iam delete-role --role-name "$role" >/dev/null 2>&1 || true
  fi
  if [ -n "$sg" ]; then
    info "removing security group $sg"
    for _ in 1 2 3 4 5 6; do
      aws ec2 delete-security-group --group-id "$sg" >/dev/null 2>&1 && break
      sleep 10   # ENI detach lags instance termination
    done
  fi
  # Restore the account's network posture EXACTLY as found. A left-attached IGW
  # in a region that had it detached is a real (if quiet) change to the account.
  if [ -n "$igw" ] && [ -n "$vpc" ]; then
    info "re-detaching $igw from $vpc (restoring blackhole posture)"
    aws ec2 detach-internet-gateway --internet-gateway-id "$igw" --vpc-id "$vpc" >/dev/null 2>&1 || true
  fi

  rm -f "$STATE"
  say "Orphan sweep"
  aws ec2 describe-instances \
    --filters "Name=tag:$TAG_KEY,Values=$TAG_VAL" Name=instance-state-name,Values=running,pending \
    --query 'Reservations[].Instances[].[InstanceId,InstanceType]' --output text \
    | sed 's/^/    LEFTOVER: /' || true
  info "(nothing listed above = clean)"
}

status() {
  say "Tagged resources in $REGION"
  aws ec2 describe-instances --filters "Name=tag:$TAG_KEY,Values=$TAG_VAL" \
    --query 'Reservations[].Instances[].[InstanceId,State.Name,InstanceType,LaunchTime]' \
    --output table || true
  [ -f "$STATE" ] && { info "recorded state:"; sed 's/^/      /' "$STATE"; } || info "no run in progress"
}

# -------------------------------------------------------------------- main

BASELINE_REF="${BASELINE_REF:-}"
cmd="${1:-preflight}"; shift || true
for a in "$@"; do [ "$a" = "--netem" ] && NETEM=1; done

case "$cmd" in
  preflight) preflight ;;
  status)    status ;;
  down)      STATE=/tmp/mehfil-scale-state.env; down ;;
  run)
    STATE=/tmp/mehfil-scale-state.env; : > "$STATE"
    if [ "$KEEP" = "1" ]; then
      trap 'say "KEEP=1 — box left running. Run: $0 down"' EXIT
    else
      trap 'down' EXIT INT TERM
    fi
    up
    provision_box
    [ "$NETEM" = "1" ] && apply_netem
    RUN_RED=0
    run_tests
    [ "${RUN_RED:-0}" = "0" ] || FINAL_EXIT=1
    ;;
  compare)
    STATE=/tmp/mehfil-scale-state.env; : > "$STATE"
    BASELINE_REF="${BASELINE_REF:-7859d00}"
    if [ "$KEEP" = "1" ]; then
      trap 'say "KEEP=1 — box left running. Run: $0 down"' EXIT
    else
      trap 'down' EXIT INT TERM
    fi
    up
    provision_box
    compare
    ;;
  *) die "usage: $0 {preflight|run [--netem]|compare|down|status}" ;;
esac
# The trap runs teardown on the way out; carry the test verdict to the caller.
exit "${FINAL_EXIT:-0}"
