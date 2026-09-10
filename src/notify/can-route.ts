/**
 * Answers whether this bridge may deliver a Feishu card for a session.
 *
 * The answer is asynchronous because ownership of a subagent session is
 * resolved through its persisted ancestor chain, and that chain comes from
 * `sessionPersistence.list()`. A synchronous predicate could only ever answer
 * for the session it was handed, which is why a Feishu task that spawned a
 * subagent used to send every escalation to the desktop instead of the chat
 * that asked for it.
 *
 * Returning `false` means "the desktop owns this request" — the caller must
 * fall back to the DSH-native answerer rather than dropping the request.
 */
export type CanRouteSessionToFeishu = (sessionId: string) => boolean | Promise<boolean>;
