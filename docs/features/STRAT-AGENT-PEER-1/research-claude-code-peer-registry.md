# Research: Claude Code 2.1.272 peer-session registry and protocol (Codex gpt-6-astra, 2026-09-15)

Source run: stratum agent run `4c165bfb3e0a`. Line refs are into a `strings -n 6` dump of `/Users/ruze/.local/share/claude/versions/2.1.272`.

I’ll trace the registry and socket code, inspect the live file shapes without exposing tokens, and tie the findings to lines in the strings dump.

The listing path probes the socket; a JSON record alone is insufficient. Listing and sending also use different identity checks: a peer can pass the listing probe but still be refused when SendMessage verifies the connected process’s PID and UID.

Two details change the implementation advice: this build uses `/list-agents` (alias `/peers`); `/agents` is a removed subagent-management command. Also, `notify_idle` is a capability name, while the wire actions are `notify_when_idle` and `peer_idle_notice`. There is no acknowledgement frame on the sending connection.

The call-site trace adds an important qualification: ordinary SendMessage does **not** pass an expected PID in this build. Idle subscriptions do when the registry supplies a verified live process. Also, the synchronous `AMe` start-token helper is a stub here, so I’ll distinguish that from the working `ps -o lstart=` path. The sandbox blocked a live `ps` check; the record and matching key file agree on the stored start time.

# Claude Code 2.1.272 peer-session protocol

**Main finding:** a third-party peer needs a connectable Unix socket and a registry record pointing to it. On macOS, the key file is optional for listing and ordinary delivery, but publishing it enables normal peer authentication. Idle subscriptions add stricter process-identity checks. [L303184–303185, L329156]

**Command correction:** this build’s peer-list command is `/list-agents`, alias `/peers`. `/agents` is a removed subagent-management command, not the peer list. [L320307, L309340]

## Evidence and scope

All `L…` references below refer to the supplied [cli-strings.txt](/private/tmp/claude-501/-Users-ruze-reg-my-forge/37ec93d5-1e7d-42cb-87a4-36c21d99c6de/scratchpad/cli-strings.txt). Code excerpts retain decoded identifiers; whitespace is occasionally added and omissions marked.

I read the dump and existing registry/key/socket metadata. Nothing was written, deleted, registered, or sent. I did **not** invoke the extracted lister: its implementation can delete stale registry files. [L303185]

---

## 1. Which records are listed?

### Actual call chain

`ListAgents` invokes `listAllPeers`; the local-session collection calls `vBn()`. The command-side implementation calls the same collector, `qvn`. [L320421, L329011, L329036]

The significant filtering is:

```js
// L303185
r = (await L({rejectUnreadable:!0}))
  .filter((d) => d.sock && !(n && NJ(d.sock,n)) && !ee(d));

function ee(e) {
  return e.spare===!0 || e.parkedJobId!==void 0
}
```

Thus:

- `messagingSocketPath` must parse as a **nonempty string**.
- A socket equivalent to the calling session’s own socket is excluded.
- `spare:true` is excluded.
- Any string-valued `parkedJobId`, including an empty string, is excluded.
- There is **no `kind==="interactive"` filter** here. `bg`, `daemon`, and `daemon-worker` can be listed if they pass the other checks. [L303185]

### Record filename and fields

The directory reader selects `/^\d+\.json$/`. Its parser obtains the PID from the filename and requires canonical decimal spelling:

```js
// L302360
let e=n.replace(/\.json$/,""), t=parseInt(e,10);
return {pid:t,canonical:String(t)===e};

// L303185
if(!m.canonical)return me(l).catch(()=>{}),null;
```

The JSON must be readable as a regular, non-symlink file, at most **262,144 bytes**. The reader uses `lstat`, `isFile()`, and a size limit. [L302360, L302467, L303185]

**The `pid` property inside the JSON is not used by this reader.** Its returned `pid` is the filename PID:

```js
// L303185
sock:typeof o.messagingSocketPath==="string"
  ?o.messagingSocketPath:"",
...
pid:f,file:l
```

The lister’s parser is permissive:

```js
// L302360
cwd:typeof e.cwd==="string"?e.cwd:"?",
startedAt:bft(e.startedAt)??0,
procStart:typeof e.procStart==="string"?e.procStart:void 0,
kind:d(e.kind),
sessionId:typeof e.sessionId==="string"?e.sessionId:void 0,
status:p(e.status)
```

`sessionId`, `kind`, `startedAt`, `cwd`, `version`, `peerProtocol`, `peerFeatures`, `name`, and `status` are **not required to survive this parsing path**. Missing metadata affects identification, presentation, or capabilities rather than constituting a schema rejection. [L302360, L303185]

The stricter `pg` schema is real, but its located uses are in concurrent-session cleanup/unclean-exit handling, **not `vBn`’s peer-record parser**. [L302468, L303185]

### Liveness: socket probe plus conditional process checks

Every candidate gets a socket connection probe:

```js
// L303185
r.on("connect",()=>i(!0));
r.on("error",(s)=>i(A(s)==="EBUSY"));
r.setTimeout(250,()=>i(!1));
```

A successful connection—or `EBUSY`—counts as reachable. A socket file that merely exists does not suffice. The probe sends no protocol message or authentication frame. [L303185]

Process checking is conditional on `pidDomain`:

```js
// L303185
async function Z(e,n) {
  if(e.pidDomain!==n)return "present";
  if(Vg(e.pid))return "gone";
  let r=e.procStartFt??e.procStart;
  if(r===void 0)return "present";
  let i=await Ga(e.pid);
  if(i===void 0||Vve(r,i))return "present";
  return await dC(e.pid,r)===!1?"recycled":"present"
}
```

Consequences:

| Condition | Listing behavior |
|---|---|
| `pidDomain` equals the current domain | Check PID death and, if supplied, start time. |
| `pidDomain` absent or different | Skip those process checks; still require socket reachability. |
| Matching domain, no `procStart` | No start-time comparison. |
| `ps` lookup unavailable | Treat process identity as present. |
| Start token differs | Recheck without cache; exclude if mismatch is confirmed. |

[L303185, L302350]

On this macOS host the domain is `"darwin"`; the constructor returns that literal for the relevant platform branch. [L302360]

`Vg` is a conservative death detector, not simply “kill succeeds”:

```js
// L302349
function Vg(e) {
  if(!P(e))return !1;
  try{return process.kill(e,0),!1}
  catch(n){return A(n)==="ESRCH"}
}
```

Only `ESRCH` establishes death. For example, permission failure does not itself exclude the record. The separate `ki` helper uses `process.kill(pid,0)` with any exception treated as failure, but **that is not the primary `vBn` liveness predicate**. [L302349, L302360, L303185]

**A `.key` file is not required to be listed. A reachable socket is.** Neither the probe nor `Z` reads the key. [L303185]

### Names and `[xxxxxx]`

For an addressable local candidate:

```js
// L302468
name:F.name||kde(F.cwd),
id:F.sock,
kind:"session"
```

`kde` is `path.basename`. Names are sanitized, whitespace-normalized, and limited to 200 characters. Address-like or reserved names can fail candidate construction. A row may nevertheless render through the list formatter’s fallback without a normal addressable `[ref]`; choose a simple nonreserved name such as `external-worker`. [L302465, L302468, L329020]

Accepted `nameSource` strings are:

```js
"user" | "peer" | "derived" | "collision" | "auto" | "hook"
```

They do not gate socket listing. `"derived"` participates in stable-name metadata; a privacy-restricted command rendering shows names only when `nameSource==="user"`. Use that value only for an actually user-chosen name. [L303185, L302468, L329026]

The suffix is derived from **SHA-256 of a candidate identity**, not the key token or name:

```js
// L302468
function Dl(e,n){return String(yn(`${e}:${n}`))}
function Kdt(e){return e.stableId??e.id}

// L302125
function yn(t){
  return on(e("sha256").update(t).digest("hex").slice(0,12))
}
```

Normally:

```text
sha256("session:" + messagingSocketPath).hex()[0:6]
```

When `tengu_session_stable_address` is enabled and the session ID is uncontested:

```text
sha256("session:sid:" + sessionId).hex()[0:6]
```

The formatter extends colliding prefixes beyond six characters, up to the available 12-character hash. Stable-ID conflicts cause socket-based fallback. This feature flag defaults to false in its accessor; I did not determine its live value. [L302468]

---

## 2. Key file contents, readers, and authentication

### Filename and contents

The filename is:

```text
~/.claude/sessions/<PID>.<SHA256(canonicalSocketPath)>.key
```

On this Unix path, canonicalization is `path.resolve`, **not `realpath`**:

```js
// L302467
function cS(e) {
  ...
  return Tde(e) // path.resolve
}
function MF(e) {
  let n=cS(e);
  return n===void 0?void 0:
    Sde("sha256").update(n).digest("hex")
}
function xF(e,n){ ... return `${e}.${r}.key` }
```

The native writer publishes:

```js
// L302467
b({
  peerToken:n,
  ...Y6(await PE()),
  pidDomain:await YL()
})
```

On macOS that produces:

```json
{
  "peerToken": "<32 lowercase hexadecimal characters>",
  "procStart": "<UTC ps lstart output, trimmed>",
  "pidDomain": "darwin"
}
```

`peerToken` is generated from 16 random bytes. The file is written with mode **0600**. The parser requires the token to match `/^[0-9a-f]{32}$/`; the start/domain fields are optional strings. Key reads are limited to **4096 bytes**. [L302467, L302350]

### Who reads it?

**The sender reads the destination’s key file.** `Pe` calls `IPr(destinationSocket, …)` and prefixes the returned token to the message. [L303184]

The receiver ordinarily generates and retains its tokens in memory, publishes its peer token, and compares incoming authentication against those in-memory tokens:

```js
// L302468
function LPr(e,n) {
  if(n===void 0)return;
  if(i0(e,n.peerToken))return "peer";
  if(i0(e,n.childToken))return "child";
}
```

`i0` uses `timingSafeEqual` after checking nonempty strings and equal byte lengths. The child token is separate and is placed in `CLAUDE_CODE_MESSAGING_TOKEN`; the published key contains the **peer** token. [L302370, L302468, L326074]

Key discovery scans filenames by the destination-path hash suffix, rather than exclusively opening the PID from a selected JSON record. If multiple keys match, it ranks their owners using liveness/start identity. With one key and macOS’s non-required-auth mode, it returns the parsed token without requiring a live owner. [L302467, L303184]

### Wire authentication

The authentication header is a **first JSON line**, not HTTP:

```json
{"type":"auth","token":"<destination peerToken>"}
```

It is followed by the application frame and newline. Only the first parsed frame can establish authentication; a later auth frame does not authenticate the connection. [L302467–302468, L326073]

Default mandatory-auth behavior is:

```js
// L302467
function k$t(){return O()==="windows"}

// L326074
c().authRequired=i.requireAuth??k$t()
```

Thus macOS defaults to optional authentication. When required, absent/invalid first-line authentication closes the connection; when optional, an invalid token does not by itself prevent the application frame from being processed. [L326073]

### Exact `procStart` production and comparison

```js
// L302350
await je("ps",["-o","lstart=","-p",String(e)],{
  timeout:1000,
  env:{...process.env,LC_ALL:"C",TZ:"UTC"}
})
// successful stdout is .trim()
```

Equivalent command:

```sh
LC_ALL=C TZ=UTC ps -o lstart= -p PID
```

Comparison is exact string equality. Preserve internal spacing—for example, `Sep  4` has two spaces before a single-digit day. `Ga` caches successful lookups for 60 seconds and misses for five seconds; `dC` bypasses the cache. [L302350]

---

## 3. Connected endpoint verification

### What `KLt` reads

```js
// L303184
function KLt(e) {
  if(O()==="windows")return;
  let n=te(e);
  try {
    let r=n<0?null:Bun.ant.getPeerPid(n);
    if(r!==null&&r>0)return r;
    ...
  } catch(r) { ... }
}
function te(e) {
  let n=e._handle;
  return typeof n?.fd==="number"?n.fd:-1
}
```

It obtains a PID from the connected socket’s file descriptor. A separate helper calls `Bun.ant.getPeerUid(fd)`. Neither value comes from JSON sent over the connection. [L303184]

### Checks performed when an expected PID is supplied

The transport checks, **before writing either auth or message bytes**:

1. Peer PID must be readable.
2. Peer PID must equal `expectPeerPid`.
3. Peer UID must be readable when the local UID is available.
4. Peer UID must equal the sender’s UID.
5. If supplied, `expectPeerProcStart` must equal `AMe(peerPid)`. [L303185]

```js
// L303185
if(s!==void 0&&O()!=="windows") {
  let y=KLt(P);
  if(y===void 0) ... "endpoint-unverifiable";
  if(y!==s) ... "wrong-endpoint";
  let I=process.getuid?.(),v=G(P);
  if(I!==void 0&&v===null) ... "endpoint-unverifiable";
  if(I!==void 0&&v!==I) ... "wrong-endpoint";
  if(l!==void 0&&AMe(y)!==l) ... "wrong-endpoint";
}
```

### Crucial call-site distinction

**Ordinary SendMessage does not supply `expectPeerPid` in this bundle**, either for explicit UDS addresses or resolved local-session names:

```js
// L321450: explicit address
await O(_.target,X,n.storageV5,D,void 0,fve(n.messages()),N)

// L321471: resolved local session
await _(s.sock,ie,n.storageV5,D,void 0,fve(n.messages()),N)
```

The eighth argument is the optional expected-identity options object; both calls omit it. [L303184]

**Idle subscription does supply the PID when `slt` establishes a registered live peer:**

```js
// L329156
let o=await slt(e);
...
let p=O()!=="windows"?o?.pid:void 0;
await i3e(e,...,{
  ...p!==void 0&&{expectPeerPid:p},
  storageV5:s
})
```

`slt` requires a registry start token and an affirmative fresh start-time match. Its returned PID comes from the registry filename. Therefore, for this verified subscription path, **the endpoint PID returned by the socket API must match that filename PID**. A different serving/helper process can fail even though listing and ordinary messages work. [L303184–303185, L329156]

Claude’s outbound notices/receipts similarly pass the connecting requester’s observed PID when available. A requester that connects from a separate helper PID can consequently make its callback listener fail that check. [L326073–326074]

### Fallback and the start-token stub

If an expected PID is supplied and `getPeerPid` is absent, throws, or provides no usable PID, sending fails with `endpoint-unverifiable`. **There is no key-token fallback for that check.** If no expected PID is supplied, the block is skipped. Windows skips it. [L303184–303185]

An important build-specific finding:

```js
// L302349
function AMe(e){return}
```

The synchronous start-token helper is a stub in this dump. Accordingly, the optional `expectPeerProcStart` check is **not** the working asynchronous `ps` check. A supplied string would mismatch this stub’s `undefined`; the receive path also cannot normally obtain a synchronous start token through it. [L302349, L303185, L326073]

I established the JavaScript/native API boundary, but not the native implementation of `Bun.ant.getPeerPid`, including inherited-listener/fork edge cases.

---

## 4. Protocol 1 framing, messages, receipts, and idle notices

### Framing and connection lifecycle

Application frames are UTF-8 JSON lines. The receiver:

- Buffers input and splits at `\n`.
- Parses each line as JSON.
- Also parses a nonempty final fragment on EOF.
- Rejects a buffered input exceeding **1,048,576 JavaScript characters**.
- Defaults to a **30-second first-complete-line deadline**. [L303184, L326073–326074]

Use newline-terminated frames and orderly EOF. Claude’s sender writes auth plus application frame, half-closes immediately except for a **150 ms delay on macOS**, and resolves on connection close with a five-second timeout. [L303184–303185]

### Incoming SendMessage envelope

A representative Claude-emitted frame is:

```json
{
  "msgV": 1,
  "msg_id": "<UUID>",
  "type": "user",
  "message": {
    "role": "user",
    "content": "<cross-session-message from=\"uds:/tmp/cc-socks/SENDER.sock\" from-name=\"sender\">\nMessage text\n</cross-session-message>"
  },
  "priority": "next",
  "from": "uds:/tmp/cc-socks/SENDER.sock"
}
```

The exact envelope builder is:

```js
// L303184
S=m1(),
w={
  ...S,
  type:"user",
  message:{role:"user",content:_},
  priority:"next",
  from:h,
  ...(s?.length??0)>0&&{file_attachments:s}
}
```

Stamp construction:

```js
// L303174
function m1(){return {msgV:n,msg_id:r()}} // n=1, r() generates UUID
```

The wrapper may additionally carry `hop-chain` and `from-mode`; supported mode values are `"bypass"` and `"prompting"`. The outer `from` is the callback address. The SendMessage `summary` is a local transcript label and is not transmitted. [L300021, L302465–302467, L321443]

The Claude receiver requires nonempty string `message.content`. It accepts priorities `now`, `next`, and `later`, defaulting to `next`. If an optional `session_id` is present and does not equal its current conversation ID, it drops the frame. The inspected dispatcher does not enforce `msgV===1`. [L326073]

### Reply / acknowledgement

**There is no synchronous JSON acknowledgement requirement.**

The sender has no `data` listener that waits for an ACK. Its success is transport completion, not confirmation that the recipient processed the message. The receiver calls `e.end()` after input EOF. A third-party receiver should consume the frame and close gracefully; it need not return `{"ok":true}`. [L303185, L326074]

Later delivery-status receipts are separate connections to the original `from` socket:

```json
{
  "type": "control",
  "msgV": 1,
  "msg_id": "<new UUID>",
  "action": "peer_message_status",
  "orig_msg_id": "<original message UUID>",
  "status": "delivered",
  "from": "uds:/tmp/cc-socks/RECEIVER.sock"
}
```

Recognized statuses are `held`, `denied`, `expired`, `delivered`, `refused`, and `dropped`. Claude’s producer represents refusal compatibly as `status:"expired", status_detail:"refused"`. These are correlated status notifications, not a mandatory ACK for every accepted message. [L303184, L326073–326074]

An actual conversational reply uses another `type:"user"` message sent to the original sender’s socket, with that destination’s authentication token. [L303184, L302467]

### Idle subscription

`notify_idle` is the advertised feature name. The request action is **`notify_when_idle`**:

```json
{
  "type": "control",
  "msgV": 1,
  "msg_id": "<subscription UUID>",
  "action": "notify_when_idle",
  "from": "uds:/tmp/cc-socks/REQUESTER.sock",
  "from_mode": "prompting"
}
```

`from_mode` is optional. A SendMessage carrying text plus `notify_when_idle:true` sends the text first, then sends this **separate control frame**, with a separate UUID. [L329156, L321471]

The subscribed receiver stores the request UUID and callback address. When idle, it opens a **new connection to the requester’s socket**, authenticates with the **requester’s** peer token, and sends:

```json
{
  "type": "control",
  "msgV": 1,
  "msg_id": "<new UUID>",
  "action": "peer_idle_notice",
  "orig_msg_id": "<subscription UUID>",
  "state": "idle",
  "finished_at": 1789456436802,
  "from": "uds:/tmp/cc-socks/RECEIVER.sock"
}
```

`finished_at` is optional epoch milliseconds. `detail` is an optional string; `state` may be `"idle"`, `"exited"`, or `"unavailable"`. The callback uses the **subscription UUID**, not the preceding user-message UUID. [L326061–326062, L326074]

Claude’s behavior is:

- One-shot subscription.
- If already idle, schedule a notice; no new model turn is needed.
- Normally debounce for **750 ms**.
- Wait until there is no queued work; held pending work also delays firing.
- Send `"exited"` on shutdown, or `"idle"` if shutdown occurs already idle with no pending work.
- Keep subscriptions for up to **12 hours**, with a 32-entry overall cap.
- Re-subscription from the same verified PID and callback target replaces the earlier subscription. [L326061]

The requester only accepts notices whose `orig_msg_id` still matches an outstanding subscription. Duplicate, expired, or unsolicited notices are dropped. Conversation changes and inbound policy can also suppress delivery to the model. **Changing registry `status` to `idle` does not generate a notice.** [L326061–326062, L326073]

### Callback paths and features

Claude validates callback addresses as `uds:` addresses. Same-directory `.sock` callbacks are accepted by the namespace check. Cross-directory callbacks are restricted to recognized default socket directories and filename shapes, with verified-peer evidence; arbitrary different directories do not automatically work. [L302467, L326073]

Feature meanings:

| `peerFeatures` entry | Meaning |
|---|---|
| `notify_idle` | Supports idle subscriptions/notices. |
| `reply_across_default_dirs` | Supports replies across the recognized default socket-directory namespaces. |
| `artifact_yield` | Supports the separate artifact-reply ownership protocol; unnecessary for basic messages and idle notices. |

[L302467–302468, L326186, L329156]

Feature arrays are sanitized to lowercase `[a-z0-9_]{1,32}` strings, at most 16 entries. A verified live peer lacking `notify_idle` is rejected as unsupported for subscription. An unverified/unknown peer may receive an attempted subscription, but Claude warns that support is unknown. [L303185, L329156]

---

## 5. Status and timestamp rendering

Allowed registry status values:

```js
// L302360
["busy","shell","idle","waiting"]
```

Invalid values become absent. The writer updates both timestamps when a status is supplied:

```js
// L302468
Pn({
  ...e,
  updatedAt:r,
  ...e.status!==void 0&&{statusUpdatedAt:r}
},n)
```

The model-facing local peer row renders:

```js
// L329020
[A,a.kind,a.status,...,`started ${w(c-a.startedAt)} ago`]
```

The command-facing row renders:

```js
// L329026
`[${y(t.status)??"unknown"}] ... started ${w(o-t.startedAt)} ago`
```

Thus the normal peer-list rows display **status and age since `startedAt`**, not age since `updatedAt`. `statusUpdatedAt` also feeds a candidate’s `lastActive` for other identity/ambiguity descriptions. [L302468, L329020, L329026]

**Stale `updatedAt` does not hide a record in ListAgents.** Neither `vBn` nor its formatter applies an age cutoff. [L303185, L329020]

There is a separate fleet-view filter that does require freshness:

```js
// L315227
A.kind==="interactive"
&& ...
&&(A.peerProtocol??0)>=qcn
&&R-(A.updatedAt??A.startedAt)<86400000
```

That is gated by `tengu_fleetview_peers` and is **not the ListAgents path**. It explains where a 24-hour cutoff, interactive-only rule, or protocol-version requirement could be mistakenly inferred. [L315227]

---

## 6. Version gates and missing-field behavior

For **ListAgents in this exact bundle**:

| Missing field | Effect |
|---|---|
| `messagingSocketPath` | Excluded: no nonempty socket address. |
| JSON `pid` | No effect here; filename PID is used. |
| `sessionId` | Still listable; unavailable for stable session-ID addressing. |
| `procStart` | Still listable; cannot establish `slt`’s strict verified-live-peer identity. |
| `pidDomain` | Still listable; `Z` skips local process-identity checks. |
| `kind` | Still listable; no kind label. |
| `name` | Falls back to basename of `cwd` for candidate naming. |
| `status` | Still listable; command renders `unknown`. |
| `updatedAt` / `statusUpdatedAt` | Still listable. |
| `version` / `peerProtocol` | No ListAgents rejection found. |
| `peerFeatures` | Still listable; a verified peer cannot accept an idle subscription through Claude’s capability check without `notify_idle`. |

[L302360, L302468, L303184–303185, L329020, L329026, L329156]

Caller-side messaging can be switched off through `CLAUDE_CODE_HARBOR_KITE` or the `tengu_harbor_kite` feature gate; the collector then skips local peer collection. This is not fixed by adding registry fields. [L303134, L329011]

### What I could not determine or verify

- **End-to-end operation:** no third-party listener or registry record was created, and no messages were sent.
- **Live process-start equality:** the sandbox refused execution of `ps`. I verified that the existing `19453.json` and its correctly hashed key file agree on `procStart` and `pidDomain`.
- **Native socket-credential internals:** the JavaScript verifies PID/UID as described, but I did not recover the native implementation’s inherited-socket semantics.
- **Live feature/policy values:** particularly stable addressing and inbound-message policy.
- **Other releases:** conclusions concern this 2.1.272 dump; they are not a claim about every Claude Code version.

---

## Minimum viable record + key + socket behaviour

### Literal listing minimum

A canonical `<real-serving-pid>.json` containing:

```json
{
  "name": "external-worker",
  "messagingSocketPath": "/tmp/cc-socks/<real-serving-pid>.sock"
}
```

can survive the listing parser, provided its socket passes the connection probe and is not the caller’s own socket. This omits identity evidence and useful presentation metadata. [L303185, L302468]

### Recommended small interoperable record

Use actual values, not these placeholders:

```json
{
  "pid": 12345,
  "sessionId": "<unique UUID>",
  "cwd": "/absolute/working/directory",
  "startedAt": 1789456307212,
  "kind": "interactive",
  "name": "external-worker",
  "procStart": "<trimmed LC_ALL=C TZ=UTC ps -o lstart= output>",
  "pidDomain": "darwin",
  "messagingSocketPath": "/tmp/cc-socks/12345.sock",
  "peerProtocol": 1,
  "peerFeatures": ["notify_idle"],
  "status": "idle"
}
```

This supplies the metadata needed for ordinary presentation and strict live-peer capability lookup. `pid`, `sessionId`, `cwd`, `startedAt`, `kind`, and `peerProtocol` are compatibility/presentation additions rather than strict listing requirements. [L302360, L303184–303185, L302468]

### Checklist

- [ ] Run the listener under the same user as Claude; use its actual PID in the record filename. This satisfies the verified idle-subscription PID/UID checks. [L303185, L329156]
- [ ] Bind a real `.sock` listener, preferably in the same `/tmp/cc-socks` directory as Claude; support empty connect/disconnect probes. [L303185, L302467]
- [ ] Publish valid JSON without `spare:true` or `parkedJobId`; record the exact UTC start string and `"pidDomain":"darwin"`. [L303185, L302350]
- [ ] Publish `<PID>.<sha256(path.resolve(socketPath))>.key`, mode 0600, containing a random 32-character lowercase-hex `peerToken`, matching `procStart`, and `pidDomain`. [L302467]
- [ ] Recognize first-line `{"type":"auth","token":...}` and compare against your published token. [L302468, L326073]
- [ ] Parse newline-delimited `user` and `control` frames; gracefully close after EOF. No synchronous ACK payload is required. [L303184–303185, L326073–326074]
- [ ] Advertise `notify_idle`; store each `notify_when_idle` request’s `msg_id` and `from`. [L329156, L326061]
- [ ] Once idle, connect back to `from`, use **that destination’s key**, and send `peer_idle_notice` with `orig_msg_id` equal to the subscription ID. Consume the subscription once sent. [L302467, L326061–326062, L326074]
- [ ] Update registry status for display; send the idle control frame separately. [L302468, L326061]
- [ ] Advertise `reply_across_default_dirs` or `artifact_yield` only if you implement those additional behaviors. [L302467–302468, L326186]