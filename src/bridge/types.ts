import type { CommandChannel } from '../commands/index.js';
import type { SendOptions } from './send-options.js';
export type { MentionTarget, SendOptions } from './send-options.js';

export interface CardStreamController {
  update(card: object): Promise<void>;
  /**
   * Recall the current process card and re-create it as the newest message in
   * the chat, rebinding the controller to that new message id. Returns the new
   * message id, or the unchanged one when re-anchoring is not possible (closed,
   * failed, or the recall failed). Used to keep an in-progress card following
   * the tail of the conversation so the user does not have to scroll up.
   */
  reanchor?(): Promise<string>;
}

export interface StreamingChannel extends CommandChannel {
  sendCard?(chatId: string, card: object, options?: SendOptions): Promise<string | undefined>;
  recallMessage?(messageId: string): Promise<void>;
  /**
   * Put an emoji reaction on a message, as a lightweight acknowledgement that
   * costs no space in the conversation.
   *
   * A phone reader wants request -> answer, not a progress card between them,
   * but with no signal at all they cannot tell whether the bot saw the message.
   * A reaction on their own message says "seen, working" without adding a
   * message of its own.
   *
   * Optional: a transport without reactions (or an app whose Feishu
   * permissions do not include them) simply omits it, and callers fall back to
   * their normal progress reporting.
   * @param messageId - the message to react to, normally the user's own.
   * @param emoji - Feishu emoji_type, e.g. `OnIt` or `DONE`.
   */
  addReaction?(messageId: string, emoji: string): Promise<string | undefined>;
  /**
   * Remove a reaction previously added by {@link addReaction}.
   * @param messageId - the message carrying the reaction.
   * @param reactionId - the id returned when it was added.
   */
  removeReaction?(messageId: string, reactionId: string): Promise<void>;
  streamCard(
    chatId: string,
    initial: object,
    producer: (controller: CardStreamController) => Promise<void>,
    options?: SendOptions,
  ): Promise<void>;
}
