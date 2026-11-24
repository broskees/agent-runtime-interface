// Drive a driver in process: create an instance, open a session, create a
// thread, start a turn, answer the approval it asks for, and read events until
// the turn's `turn.terminal`.
//
// The driver is the conformance kit's reference driver. Its agent runs in
// memory and acts only on the script in `playAgent`, so this runs anywhere
// with no account. A real driver's agent acts on its own: drop `playAgent`.
import type { RequestOption } from "ari";
import { REFERENCE_WORKSPACE, createFakeHost, referenceHarness } from "ari/conformance";

const rig = await referenceHarness().setup({ scenario: "quickstart", workspace: REFERENCE_WORKSPACE, ambientAuth: "authenticated" });
const driver = rig.driver;
const config = driver.defaultConfig();
const host = createFakeHost({ ...(await rig.hostOptions?.("quickstart", { managedProfile: false })), config });

const instance = await driver.create(host, { instanceId: "quickstart", config, environment: {} });
const session = await instance.openSession({});
const cwd = REFERENCE_WORKSPACE.cwd;
const thread = await session.createThread({ cwd, policy: { mode: "approval_required", interaction: "default", cwd } });

const started = await session.startTurn({
  threadId: thread.id,
  clientTurnKey: "quickstart-turn-1",
  intent: "start",
  content: [{ type: "text", text: "List the files." }],
});
if (started.status !== "accepted") throw new Error(`the turn was not accepted: ${started.status}`);

// The reference agent's side of the turn: ask to run `ls`, then answer.
async function playAgent(): Promise<void> {
  const turn = await rig.native.nextTurn();
  const approval = await turn.requestApproval({
    kind: "command",
    command: ["ls"],
    options: [
      { optionId: "allow", label: "Allow", decision: "accept" },
      { optionId: "deny", label: "Deny", decision: "decline" },
    ],
  });
  const reply = await approval.nextReply();
  await turn.say(reply === "allow" ? "README.md and src/." : "I did not run ls.");
  await turn.complete();
}
const agent = playAgent();

let reply = "";
for await (const event of session.events()) {
  const body = event.body;
  if (body.type === "request.upsert" && body.request.status === "pending") {
    // Approve once: pick the option that accepts without widening the scope.
    const accept = body.request.options?.find((option: RequestOption) => option.decision === "accept");
    if (accept === undefined) throw new Error("the approval offers no accept option");
    console.log(`approving: ${accept.label}`);
    await session.respond({ requestId: body.request.id, responseKey: "quickstart-answer-1", optionId: accept.optionId });
  }
  if (body.type === "item.delta" && body.field === "text") reply += body.chunk;
  if (body.type === "turn.terminal" && body.turnId === started.turnId) {
    console.log(`assistant: ${reply}`);
    console.log(`turn ${body.status}`);
    break;
  }
}

await agent;
await session.close();
await instance.dispose();
await rig.dispose?.();
