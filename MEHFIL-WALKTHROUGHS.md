# Mehfil — User Flow Walkthroughs

**Companion document to MEHFIL-SPEC.md**
**Purpose:** testable user flow scenarios for QA, coding agents, and acceptance testing

Each walkthrough is structured as:
- **Phase / Tier:** which lifecycle phase, which workspace tier
- **Preconditions:** state before the flow starts
- **Steps:** numbered user actions
- **Expected:** acceptance criteria — what must be observable for the flow to pass
- **Edge cases:** known variants worth testing

---

## Phase 1 — First contact

### WT-01: First-ever launch and workspace creation

**Phase:** First contact · **Tier:** 1
**Preconditions:** No prior Mehfil state in this browser. IndexedDB empty.

**Steps:**
1. Open `mehfil.app` in a fresh browser
2. Observe the landing screen
3. Click "Start a workspace"
4. Enter workspace name "Acme"
5. Click create

**Expected:**
- Landing screen shows exactly three options: "Start a workspace", "Join a workspace", "I have a backup file"
- No email, phone, or username field anywhere
- After clicking "Start a workspace", a single name field appears
- After create: client generates Ed25519 identity, workspace root key, default `general` channel — all client-side
- User lands directly in `general` with cursor in the message composer
- No backup nag yet (deferred until first message)
- IndexedDB now contains a `mehfil_<workspace_id>` database with `keys`, `members`, `channels` populated

**Edge cases:**
- Empty workspace name → field validation, no submission
- Workspace name with emoji → accepted, rendered correctly
- Browser without IndexedDB support → friendly error: "Mehfil needs IndexedDB. Try Firefox, Chrome, or Safari."

---

### WT-02: First message and the backup nag

**Phase:** First contact · **Tier:** 1
**Preconditions:** WT-01 complete. User is in `general`, no messages yet.

**Steps:**
1. Type "hello" in the composer
2. Press Enter
3. Observe the channel for the next 5 seconds
4. Click "Back up" on the banner that appears
5. Enter a passphrase, confirm
6. Click download
7. Verify a `.mehfil-key` file lands in the user's downloads

**Expected:**
- Message appears in the channel immediately, attributed to the user
- 3 seconds after sending, a non-modal banner slides in from the top with the text "Back up your identity now"
- Banner has two buttons: "Back up" and "Later"
- After "Back up": passphrase + confirm form appears
- After download: banner is replaced by a small green checkmark in the corner
- File contains the passphrase-wrapped identity key in the documented format

**Edge cases:**
- Click "Later" → banner collapses to a small orange warning dot in the corner; reappears as banner once per session
- After 7 days unbacked → banner becomes full-width, doesn't auto-dismiss for 5 seconds
- Passphrase mismatch on confirm → inline validation error
- Cancel download mid-flow → backup status unchanged, nag continues

---

### WT-03: The "send yourself a message" empty-state hint

**Phase:** First contact · **Tier:** 1
**Preconditions:** WT-01 complete. No invites sent yet. User is the only member.

**Steps:**
1. Look at the main message area in `general`
2. Click the "try sending yourself a message" link in the empty state card

**Expected:**
- Empty state card is centered in the channel area, contains the text "You're the only one here"
- Two links: "Invite someone" and "Try sending yourself a message"
- Clicking the second inserts a placeholder message into the channel from the user's own identity
- The placeholder is just a regular `message.create` envelope, persisted to IndexedDB
- Empty state disappears after the first real or placeholder message

**Edge cases:**
- Refresh after the placeholder → message is still there (it was a real envelope, not a UI fake)

---

## Phase 2 — Two-person flows

### WT-04: Invite the second person via QR (in-room)

**Phase:** Invite · **Tier:** 1
**Preconditions:** WT-01 complete. Inviter has another device with a camera nearby.

**Steps:**
1. Click "Invite" in the sidebar
2. Select "They're in the room with me"
3. Observe the QR code, the URL, and the fingerprint display
4. On the second device, open the camera or a QR scanner
5. Scan the QR

**Expected:**
- Invite panel shows: large QR code, selectable URL below it, fingerprint in 8 groups of 4 hex chars at large readable size, colored visual hash trust card next to the fingerprint
- Caption explains the verification step
- QR encodes the join payload as documented in spec §10
- Scanned URL opens to `mehfil.app/#join=<payload>`

**Edge cases:**
- QR code at high contrast (test scannability across lighting conditions)
- Fingerprint and trust card must match deterministically with the inviter's identity (verifiable by hashing the pubkey)

---

### WT-05: Invite the second person via link share (remote)

**Phase:** Invite · **Tier:** 1
**Preconditions:** WT-01 complete.

**Steps:**
1. Click "Invite"
2. Select "They're remote"
3. Click "Copy link"
4. Send the link via any external channel
5. Verify the inviter fingerprint with the recipient via a separate channel

**Expected:**
- Invite panel shows: copy-link button, fingerprint + trust card displayed prominently, instruction to verify out of band
- A small disclosure "Why fingerprints?" expands to a 2-sentence explanation
- Copied link is in the format `https://mehfil.app/#join=<payload>`
- Link contains all transport endpoints currently configured for the workspace

**Edge cases:**
- On mobile, the panel surfaces the native share sheet as the primary action
- On desktop, copy-to-clipboard is the primary action

---

### WT-06: Invite via 6-word pairing code

**Phase:** Invite · **Tier:** 3+ (requires relay)
**Preconditions:** WT-01 complete. A relay has been configured for this workspace.

**Steps:**
1. Click "Invite"
2. Select "Type a code"
3. Observe the 6 BIP39 words displayed
4. Read the words to the recipient
5. Recipient opens `mehfil.app`, clicks "Join a workspace", clicks "I have a code"
6. Recipient types the 6 words

**Expected:**
- Words are displayed in a readable monospace font, large
- Words are numbered 1–6 for clarity
- A 5-minute countdown timer is visible
- The pairing payload has been posted to `/pairing/{code}` on the relay
- Recipient typing the words successfully fetches and decrypts the payload
- After 5 minutes, the code expires and the relay returns 404

**Edge cases:**
- Typo in the words → decryption fails → friendly error "That code didn't work. Make sure all 6 words are correct."
- Code expired → relay returns 404 → friendly error "That code has expired. Ask for a new one."
- No relay configured → "Type a code" option is disabled with explanation

---

### WT-07: Joining as the invitee (link path)

**Phase:** Join · **Tier:** 1
**Preconditions:** A valid join link has been received.

**Steps:**
1. Open the join link in a fresh browser
2. Read the workspace name, inviter name, and fingerprint
3. Verify the fingerprint with the inviter out of band
4. Click "The fingerprint matches"
5. Enter your name
6. Pick an avatar color
7. Land in `general`

**Expected:**
- Join screen shows: workspace name, inviter name, inviter fingerprint, trust card, bridge fingerprint (if present)
- Verification prompt is unskippable — the "matches" button is the same size as cancel, has no Enter shortcut
- After confirming: name + avatar color screen (no email or other fields)
- After completing: client generates identity, posts `member.join` envelope, lands in `general`
- Inviter's existing messages are visible (after `member.welcome` arrives)
- Inviter sees the new member appear in the sidebar within seconds

**Edge cases:**
- Click "Cancel" → returns to landing screen, no state created
- Expired invite → "This invite has expired" error
- Tampered URL fragment → decryption fails → "This invite link is corrupted"

---

### WT-08: First live message between two peers (Mode A)

**Phase:** Live messaging · **Tier:** 1
**Preconditions:** WT-07 complete. Both peers are in `general` simultaneously.

**Steps:**
1. Inviter types a message and sends
2. Observe inviter's view
3. Observe joiner's view

**Expected:**
- Message appears in inviter's view immediately with a single check (sent locally)
- Within 1 second, message appears in joiner's view via WebRTC data channel
- Inviter's check becomes a double check (delivered)
- Both views show the corner badge as 🟢 Live
- Hovering the badge shows "Connected to 1 peer via WebRTC"

**Edge cases:**
- Joiner closes their tab → inviter's badge becomes 🔴 within 30 seconds, queued messages start accumulating
- Joiner reopens → reconnect happens automatically, queued messages flush

---

## Phase 3 — Growing the workspace

### WT-09: Adding a third member (gossip mode kicks in)

**Phase:** Growth · **Tier:** 2
**Preconditions:** WT-07 complete. Workspace has 2 members.

**Steps:**
1. Either of the two existing members clicks "Invite"
2. Sends a join link to the third person
3. Third person joins via WT-07 flow
4. Lands in `general`

**Expected:**
- Workspace tier transitions from 1 to 2
- Default transport mode is now Mode B (gossip)
- All three clients establish WebRTC data channels with each other (full mesh of 3 connections)
- A `gossip.peer_announce` envelope is sent by the new member to inform others
- Onboarding density remains "verbose"
- Member count in workspace doc updates to 3

**Edge cases:**
- Third member joins while only one of the original two is online → inviter relays the workspace doc, the offline second member catches up via gossip when they next come online
- All three online simultaneously → fastest-path delivery via direct WebRTC, no relay involved

---

### WT-10: Tier 2 → Tier 3 escalation prompt

**Phase:** Growth · **Tier:** 2 → 3
**Preconditions:** Workspace has 5–6 members. Gap detection has triggered more than 3 times in 24 hours, OR half the members have been simultaneously offline more than once in a week.

**Steps:**
1. Open the workspace
2. Observe the banner at the top of the message area

**Expected:**
- Banner appears with the text "Acme is getting big enough that members will start missing messages when they're not online together"
- Two buttons: "Set this up" and "Dismiss"
- "Set this up" links directly to Settings → Transports
- "Dismiss" hides the banner; it reappears after 7 days if conditions still hold
- Banner does not block any other UI

**Edge cases:**
- After adding a relay, the conditions clear and the banner does not reappear
- Dismissed banner does not affect other members — each device tracks its own dismissal state

---

### WT-11: Bridge install moment (taken path)

**Phase:** Growth · **Tier:** 3 → 4
**Preconditions:** Workspace has ≥6 members, in an office. User clicks "Set this up" from the WT-10 banner, then chooses "Add a bridge."

**Steps:**
1. Settings → Transports → Add bridge
2. Read the explanation
3. Click the install command appropriate for the user's OS
4. Run the command in a terminal
5. Return to the browser
6. Observe the auto-detection

**Expected:**
- Settings panel shows OS-specific install options (Mac/PC/Linux/Pi) with clear instructions
- Each option has a "What does this actually do?" disclosure (4-line plain explanation)
- After the bridge starts on the LAN, the browser tab auto-detects it within 10 seconds
- A "Bridge connected ✓" badge appears showing the bridge fingerprint
- The bridge fingerprint is added to the workspace doc as a pinned trust anchor
- Other members see the bridge appear in their workspace doc and connect to it

**Edge cases:**
- Bridge runs but is on a different subnet → manual URL entry option is available
- Bridge fingerprint differs from the pinned one → warning: "This bridge isn't the one your workspace trusts"
- Bridge install fails → no auto-detection, user sees "Still waiting..." with a help link

---

### WT-12: Bridge install moment (skipped path — gossip mode continues)

**Phase:** Growth · **Tier:** 3
**Preconditions:** WT-10 banner shown. User clicks "Dismiss" or chooses "I'll do this later."

**Steps:**
1. Click "Dismiss"
2. Continue using the workspace normally
3. Observe message delivery patterns

**Expected:**
- Workspace continues operating in gossip mode
- Messages still deliver when peers overlap online
- Gap detection banners may appear in channels when overlap fails
- No degradation of the core experience for the cases that gossip handles
- Banner reappears in 7 days if conditions still trigger

---

## Phase 4 — Daily use

### WT-13: Create a public channel

**Phase:** Daily use · **Tier:** any
**Preconditions:** User is in a workspace with at least one channel.

**Steps:**
1. Click `+` next to the channel list
2. Enter channel name "design"
3. Optionally enter a topic
4. Select "Public"
5. Click create

**Expected:**
- New channel panel appears as a side panel or modal
- "Public" is selected by default
- Tooltip on "Public" explains: "Everyone in the workspace can join and read history"
- After create: a `channel.create` envelope is posted, the workspace doc updates
- The new channel appears in the sidebar for all members
- The user is automatically the first member of the new channel
- Channel uses the workspace root key wrapping for its channel key

**Edge cases:**
- Duplicate channel name → validation error
- Empty name → validation error
- Channel name with spaces → either rejected or normalized to dashes

---

### WT-14: Create a private channel

**Phase:** Daily use · **Tier:** any
**Preconditions:** User is in a workspace with at least 3 members.

**Steps:**
1. Click `+` next to the channel list
2. Enter channel name "leadership"
3. Select "Private"
4. Add 2 members from the multi-select
5. Click create

**Expected:**
- "Private" option has a tooltip: "Even other workspace members can't read this channel without an invite. Mehfil generates a new key just for this channel."
- After selecting Private, a member multi-select appears
- After create: a fresh channel key is generated, wrapped per-member with X25519
- The channel appears with a small lock icon next to its name
- Hovering the lock icon shows "Encrypted with a key only the 3 members can decrypt"
- Members not added cannot see the channel in their sidebar at all

**Edge cases:**
- Add zero members → validation error
- Add yourself as the only member → allowed, channel created with one member
- Remove a member later → triggers `channel.rekey`

---

### WT-15: Start a 1:1 DM

**Phase:** Daily use · **Tier:** any
**Preconditions:** Workspace has at least 2 members.

**Steps:**
1. Click `+` next to the DM list
2. Type a member's name
3. Click on the matching member
4. Type a message
5. Send

**Expected:**
- Member picker filters as the user types
- DM tab opens immediately, but no envelope is sent until the first message
- DM key is derived via X25519 between the two pubkeys
- Message envelope encrypts under the derived key
- Recipient sees the new DM appear in their sidebar only after the first message arrives
- DM uses a `dm: true` flag in the inner payload

**Edge cases:**
- DM with self → allowed, single-user DM (notes-to-self)
- DM with a member whose pubkey just changed (e.g. after device revoke + re-add) → uses the current pubkey

---

### WT-16: Start a group DM

**Phase:** Daily use · **Tier:** any
**Preconditions:** Workspace has at least 3 members.

**Steps:**
1. Click `+` next to DMs
2. Type names of 2+ members, separated by comma
3. Send first message

**Expected:**
- Group DM tab opens with all selected members
- Sender-keys pattern: sender generates their own group key, distributes to members on first message
- Each subsequent member who joins later generates their own sender key
- New members joining the group see only messages from after they joined

**Edge cases:**
- Add a member to an existing group DM → new sender keys distributed; old messages remain readable to the original participants
- Remove a member → new sender keys generated for remaining members for future messages

---

### WT-17: Attach an image

**Phase:** Daily use · **Tier:** any
**Preconditions:** User is in a channel.

**Steps:**
1. Drag a small image file (under 25MB) into the channel
2. Observe the upload status
3. Add a message body
4. Send

**Expected:**
- Inline preview appears in the composer immediately
- Status: "Encrypting..." → "Uploading..." → "Ready"
- Per-blob AES key generated client-side
- Encrypted blob written to OPFS local
- If a relay is configured, encrypted blob also uploaded to the relay
- After "Ready": the user can send
- Message envelope includes an `attachment.ref` payload with blob ID, size, mime, encrypted per-blob key, and location URL
- Recipients see a thumbnail rendered from the decrypted blob

**Edge cases:**
- File over 25MB → rejected with "v1 limit is 25MB"
- No relay configured (gossip mode) → blob stays local; recipients see "available when [sender] is online" until they fetch directly
- Recipient offline → fetches on next online via the relay or gossip
- Network error mid-upload → retry button appears

---

### WT-18: Local search (in-channel)

**Phase:** Daily use · **Tier:** any
**Preconditions:** Workspace has accumulated at least 100 messages.

**Steps:**
1. Press Cmd/Ctrl+K
2. Type a query
3. Observe results
4. Click a result

**Expected:**
- Search palette overlays the current view
- Results appear instantly as the user types — no loading spinner
- Each result shows: channel name, timestamp, message snippet with matched terms highlighted
- Clicking a result jumps to the message in context with the message highlighted briefly
- Filters supported: `from:`, `in:`, `has:link`, `has:file`, `before:`, `after:`

**Edge cases:**
- Search across special characters → handled correctly
- Query with multiple terms → AND semantics by default
- Empty query → palette shows recent searches if any

---

### WT-19: Cross-workspace search

**Phase:** Daily use · **Tier:** any
**Preconditions:** User has at least 2 workspaces on this device.

**Steps:**
1. Press Cmd/Ctrl+K
2. Type a query
3. Observe that results come from multiple workspaces

**Expected:**
- Results are grouped by workspace, with workspace name as section header
- Results from the current workspace appear first
- Clicking a result from another workspace opens that workspace in a new tab and jumps to the message
- Bottom of palette shows "Searching N messages across M workspaces"

**Edge cases:**
- A workspace has no messages → not shown as a section
- A workspace's index is corrupted → that workspace shows "Search index needs rebuild" with a button

---

## Phase 5 — Administration

### WT-20: Settings — backup identity

**Phase:** Administration · **Tier:** any
**Preconditions:** User has not yet backed up.

**Steps:**
1. Open Settings → Identity
2. Click "Back up identity"
3. Set a passphrase, confirm
4. Download the file

**Expected:**
- Settings shows the user's name, avatar, fingerprint, trust card
- "Back up identity" button is prominent if no backup exists
- After backup: button changes to "Re-download backup" with the date of the existing backup shown
- Downloaded file is in the documented `.mehfil-key` format

**Edge cases:**
- Forgotten passphrase on re-download → cannot recover; same caveat applies

---

### WT-21: Settings — add a relay

**Phase:** Administration · **Tier:** 3+
**Preconditions:** User has admin role. User has deployed a Cloudflare R2 relay.

**Steps:**
1. Settings → Transports → Add relay
2. Select "Cloudflare R2"
3. Enter the relay URL and bearer token
4. Click test
5. Click save

**Expected:**
- Add relay form shows adapter type dropdown, URL field, token field
- "Test" button performs a `GET /ws/{workspace_id}/cursor` and reports success or failure
- After save: relay configuration is added to the workspace doc as a `workspace.patch`
- Other members' clients pick up the new relay on next sync and start using it
- Corner badge changes to 🟢 Live or 🟡 Sync depending on other transport status

**Edge cases:**
- Wrong token → test fails with clear error
- URL unreachable → test fails with timeout
- Invalid URL format → inline validation

---

### WT-22: Member removal and rekey

**Phase:** Administration · **Tier:** any
**Preconditions:** User is admin. Workspace has at least 3 members.

**Steps:**
1. Open the member list
2. Click on a member
3. Click "Remove from workspace"
4. Read the confirmation modal
5. Click "Remove and rekey"
6. Observe the progress

**Expected:**
- Confirmation modal shows the explicit text: "Bose will keep any messages he already received. He won't see anything new."
- Two buttons: "Remove and rekey" and "Cancel"
- After confirm: progress indicator shows "Generating new keys → Wrapping for N members → Posting workspace update"
- A `workspace.rekey` envelope is posted with new wrapped root keys
- A `channel.rekey` envelope is posted for each public channel
- Removed member's client, on next sync, sees the rekey envelope but cannot decrypt the new keys (they're not wrapped for them)
- Banner appears for remaining members: "Bose removed. New keys active."

**Edge cases:**
- Remove yourself → not allowed for the only admin (use admin transfer or promote-by-consensus first)
- Remove a member who is currently online → their tab shows "You've been removed from this workspace" within 30 seconds
- Network failure mid-rekey → retry; idempotent because keys are content-addressed

---

### WT-23: Promote-by-consensus (dead admin recovery)

**Phase:** Administration · **Tier:** any
**Preconditions:** Workspace's only admin has lost their key (or is otherwise unable to act). At least 2 other members exist.

**Steps:**
1. Member 1 opens Settings → Workspace → "Admin not responding?"
2. Reads the explanation
3. Selects a member to promote (Member 2)
4. Clicks "Nominate"
5. Member 2 opens the workspace and sees a banner: "You've been nominated as admin"
6. Member 2 (or any other non-nominator member) clicks "Co-sign"
7. The promotion takes effect

**Expected:**
- "Admin not responding?" option is visible only to non-admin members and only when no admin has been online for more than X days (configurable, default 30)
- Nomination modal explains: "Any 2 members can promote a new admin. This is for cases where the current admin has lost their key or left."
- Selecting a nominee creates a `member.promote` envelope signed by the nominator
- The pending promotion is stored in the workspace doc under `pending_promotions`
- Other members see the pending promotion in their workspace UI
- A second member co-signs by clicking → adds their signature to the envelope's `cosigs` array
- Once 2 distinct signatures are present, the envelope is valid and the role transitions
- The workspace doc updates to show the new admin
- Pending promotion is cleared

**Edge cases:**
- Original admin comes back online before threshold reached → they can cancel the pending promotion
- Pending promotion older than 7 days → auto-expired on next workspace operation
- The nominator tries to co-sign their own nomination → rejected (must be 2 *distinct* members)

---

## Phase 6 — Identity & devices

### WT-24: Identity recovery from backup file

**Phase:** Identity · **Tier:** any
**Preconditions:** User has a `.mehfil-key` backup file. New browser, no Mehfil state.

**Steps:**
1. Open `mehfil.app`
2. Click "I have a backup file"
3. Select the `.mehfil-key` file
4. Enter the passphrase
5. Click restore

**Expected:**
- File picker opens
- After file selected and passphrase entered: identity is unwrapped and stored in IndexedDB
- The workspace launcher screen appears with any workspaces this identity participates in
- Important: workspaces are NOT automatically restored from the backup file alone — the file contains only the identity. Workspaces must be re-synced from peers or a relay.
- For workspaces with reachable peers/relays, the user can click into a workspace and it will sync from scratch
- For workspaces with no reachable transports, the workspace appears empty until a peer is found

**Edge cases:**
- Wrong passphrase → "Couldn't unlock. Check your passphrase."
- Corrupted file → "This doesn't look like a Mehfil backup file"
- File from a different version → version compatibility check

---

### WT-25: Lost everything (no recovery)

**Phase:** Identity · **Tier:** any
**Preconditions:** User has lost all devices and has no backup file.

**Steps:**
1. Open `mehfil.app` on a new device
2. Click "What if I lose my key?" link

**Expected:**
- The link is on the landing screen, not buried in settings
- It opens a page (or modal) with the documented explanation: no central recovery, must be re-invited under new identity
- Page also shows preventive measures with links to: backup flow, multi-device pairing (when v1.1 ships)
- No false hope, no "contact support"

**Edge cases:**
- This walkthrough has no "success" path — it's a documentation/UX test that the failure mode is clearly explained

---

### WT-26: Multi-device pairing in-room (v1.1)

**Phase:** Identity · **Tier:** any · **v1.1 only**
**Preconditions:** User has Mehfil set up on Device A. Device B is in the same room.

**Steps:**
1. On Device A: Settings → Devices → Add device
2. Observe the QR code and 6-word backup code displayed
3. On Device B: open `mehfil.app` → "Add this device to an existing identity"
4. Scan the QR with Device B's camera
5. On Device A: see the new-device confirmation prompt with Device B's fingerprint
6. Confirm on Device A
7. Device B is now part of the identity

**Expected:**
- Pairing payload contains identity public key, ephemeral X25519 key, signed nonce with 5-min TTL
- After scan, Device B completes the handshake locally (via the workspace's bridge or gossip)
- Device A receives a confirmation request showing Device B's new fingerprint
- Confirming on Device A causes the identity key to be transferred encrypted under the ephemeral X25519 key
- Device B now has the identity and posts a `device.add` envelope to the workspace
- Other workspace members see Device B added to the user's device list
- Vector clocks now have a new `(user, device_b)` entry

**Edge cases:**
- Device A loses connection mid-pairing → pairing fails, must restart
- Device B's fingerprint doesn't match Device A's display → user can decline (defends against MITM)

---

### WT-27: Multi-device pairing remote with code (v1.1)

**Phase:** Identity · **Tier:** 3+ · **v1.1 only**
**Preconditions:** User has Mehfil on Device A. Wants to add Device B, which is not in the same room. Relay is configured.

**Steps:**
1. On Device A: Settings → Devices → Add device → "Use a code"
2. Observe the 6 words
3. Read the words to the recipient (or send via secure channel)
4. On Device B: open `mehfil.app` → "Add this device to an existing identity" → "I have a code"
5. Type the 6 words
6. On Device A: confirm the new device

**Expected:**
- Same flow as WT-26 but the handshake goes via the relay's `/pairing` endpoint
- 5-minute TTL on the code
- All other steps identical

**Edge cases:**
- Relay unreachable → fall back to in-room QR or fail with clear message

---

### WT-28: Revoke a device (v1.1)

**Phase:** Identity · **Tier:** any · **v1.1 only**
**Preconditions:** User has 2+ devices paired. One is lost.

**Steps:**
1. On the remaining device: Settings → Devices
2. See the list of devices
3. Click "Revoke" on the lost device
4. Read the confirmation
5. Confirm

**Expected:**
- Device list shows all paired devices with last-seen times and fingerprints
- Confirmation modal explains: "this device will no longer be able to send messages as you, but old messages it sent remain valid"
- After confirm: a `device.revoke` envelope is signed and posted
- Other workspace members update their member doc
- The revoked device, on next launch, sees the revocation and wipes its local store

**Edge cases:**
- Revoking the only device → not allowed (would lock the user out of their own identity)

---

## Phase 7 — Workspace shell & navigation

### WT-29: Workspace launcher with multiple workspaces

**Phase:** Navigation · **Tier:** any
**Preconditions:** User has at least 2 workspaces on this device.

**Steps:**
1. Open `mehfil.app` (no specific workspace in URL)
2. Observe the launcher
3. Click into one workspace
4. Use Cmd+T to open a new tab
5. Open the second workspace in the new tab
6. Use Cmd+1 / Cmd+2 to switch between them

**Expected:**
- Launcher shows each workspace as a card with name, member count, last activity
- Plus buttons: "+ New" and "+ Join"
- Clicking a card opens that workspace in the current tab
- Cmd-clicking opens in a new tab
- No in-app workspace switcher exists — the browser tabs are the switcher
- Each tab is fully isolated; opening the same workspace in two tabs is allowed

**Edge cases:**
- Single workspace → launcher might be skipped, opens directly into that workspace (configurable)
- Zero workspaces → landing screen (not launcher)

---

## Phase 8 — Edge cases and failure modes

### WT-30: Sending while offline (queueing)

**Phase:** Edge case · **Tier:** any
**Preconditions:** User is in a workspace. All transports are down.

**Steps:**
1. Disconnect from network (or close bridge / kill relay)
2. Type a message and send
3. Observe the message state in the channel
4. Reconnect
5. Observe the state transition

**Expected:**
- Corner badge shows 🔴 Offline
- Sent message appears in the channel with a clock icon and faintly different background
- Subtitle on hover: "queued — will deliver when peers are reachable"
- Reconnect: badge transitions to 🟢 Live or 🟡 Sync
- Queued messages flush; clock icon becomes single check, then double check as delivery confirms
- No spinner anywhere

**Edge cases:**
- Reconnect to a different transport than originally used → still works
- Multiple queued messages → delivered in order, all show the right state transitions

---

### WT-31: Gap detection and resync

**Phase:** Edge case · **Tier:** 2+
**Preconditions:** Workspace with 3+ members, gossip mode. Member B has been offline. Member B comes back online and connects to a peer that has *some* but not all of the messages B missed.

**Steps:**
1. Member B opens the workspace
2. Connects to one peer
3. Observes the channel scrollback
4. Spots a gap indicator
5. Clicks "Try to fetch"

**Expected:**
- Inline banner appears in the channel scrollback at the position where messages are missing
- Banner says "Missing 3 messages from Cara" with a "Try to fetch" button
- Clicking the button posts a `gossip.resync_request` envelope to all reachable peers
- If any reachable peer has the missing envelopes, they are sent back and inserted in the right place
- Banner is replaced by the actual messages
- If no peer has them after 30 seconds, banner becomes "Missing 3 messages from Cara (no peer has them yet)" and remains until the messages arrive or the user dismisses

**Edge cases:**
- The missing messages arrive automatically → banner is silently replaced
- Gap detected for a member who has been removed → banner shows the removed member's name with a note "(member is no longer in the workspace)"

---

### WT-32: Bridge fingerprint mismatch warning

**Phase:** Security · **Tier:** 4
**Preconditions:** Workspace has a bridge configured with a pinned fingerprint. An attacker on the LAN runs a fake `mehfil-bridge` advertising the same mDNS name.

**Steps:**
1. User opens the workspace from a browser on the same LAN
2. Client discovers two `mehfil-bridge` advertisements via mDNS
3. Client attempts to connect to the legitimate one first (by fingerprint check)

**Expected:**
- If the client connects to the fake bridge first, it sees a fingerprint mismatch with the workspace doc
- Warning modal: "The bridge on this network isn't the one your workspace trusts. The fingerprint doesn't match."
- Two buttons: "Don't connect" (default) and "Trust this bridge anyway"
- "Trust anyway" requires a second confirmation step
- Connecting to the legitimate bridge: silent success

**Edge cases:**
- First-time setup, no fingerprint pinned yet → no warning, fingerprint pinned on first successful connection
- Bridge legitimately rotated keys → admin must update the pinned fingerprint manually via Settings

---

### WT-33: XSS attempt via message content

**Phase:** Security · **Tier:** any
**Preconditions:** None.

**Steps:**
1. Send a message containing `<script>alert(1)</script>`
2. Send a message containing `[click me](javascript:alert(1))`
3. Send a message containing `<img src=x onerror=alert(1)>`
4. Observe the rendered output

**Expected:**
- All three messages render as plain text (or with the inert link), no JavaScript executes
- The markdown renderer is configured with `html: false`
- Link sanitizer rejects `javascript:` URLs
- CSP header on the hosted page disallows inline scripts

**Edge cases:**
- Combination attacks (encoded characters, mixed-case, etc.) → all rejected
- A legitimate code block containing the same text → rendered as visible code, not executed

---

### WT-34: Workspace export and import

**Phase:** Backup · **Tier:** any
**Preconditions:** User has an active workspace with messages.

**Steps:**
1. Settings → Workspace → Export
2. Set a passphrase
3. Download the `.workspace` file
4. On a different browser (or after clearing IndexedDB), open `mehfil.app`
5. Click "I have a backup file" → choose Workspace import
6. Select the file, enter the passphrase
7. Verify the workspace is restored

**Expected:**
- Export file is a zip containing `envelopes.msgpack`, `keys.enc`, `meta.json`
- Import replays envelopes into a fresh local DB
- After import, all channels, messages, members are visible
- The user's identity must already be present (from a separate identity backup) for the import to work — open call: clarify in spec whether v1 includes identity in workspace export by default

---

### WT-35: Tier-aware onboarding density (verbose vs minimal)

**Phase:** UX validation · **Tier:** 1 vs 4
**Preconditions:** Two test workspaces — one with 2 members, one with 30 members.

**Steps:**
1. Join the 2-member workspace as a new member
2. Observe the join screen, fingerprint verification, post-join tooltips
3. Join the 30-member workspace as a new member
4. Observe the same screens

**Expected:**
- 2-member workspace: full explanatory paragraphs, all tooltips visible by default, "send yourself a message" hints, expanded settings explanations
- 30-member workspace: terse one-line prompts, tooltips on hover only, no hints, minimal settings copy
- Same underlying flow in both cases — only copy density differs
- The density is driven by `member_count` in the workspace doc

---

## Coverage matrix

| Phase | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
|---|---|---|---|---|
| First contact | WT-01, 02, 03 | — | — | — |
| Invite | WT-04, 05 | WT-06 | WT-06 | — |
| Join | WT-07 | WT-07 | WT-07 | WT-07 |
| Live messaging | WT-08 | WT-09 | — | — |
| Growth | — | WT-09 | WT-10, 11, 12 | WT-11 |
| Daily use | WT-13 to 19 | WT-13 to 19 | WT-13 to 19 | WT-13 to 19 |
| Administration | — | WT-22 | WT-20, 21, 22, 23 | WT-20, 21, 22, 23 |
| Identity (v1.1) | WT-24, 25 | WT-26, 27, 28 | WT-26, 27, 28 | WT-26, 27, 28 |
| Navigation | WT-29 | WT-29 | WT-29 | WT-29 |
| Edge cases | WT-30, 33, 34 | WT-30, 31, 33, 34 | WT-30, 31, 32, 33, 34 | WT-30, 31, 32, 33, 34 |
| UX validation | WT-35 (small side) | — | — | WT-35 (large side) |

---

## Acceptance gating

For v1 to ship:
- **All Phase 1–5 walkthroughs** must pass
- **WT-30, WT-31, WT-32, WT-33, WT-34** must pass (edge cases and security)
- **WT-35** must pass (validates tier-aware UI)
- v1.1-marked walkthroughs (WT-26, 27, 28) are reserved for v1.1

For v1.1 to ship:
- All v1 walkthroughs continue to pass
- WT-26, 27, 28 pass

---

**End of walkthroughs.**
