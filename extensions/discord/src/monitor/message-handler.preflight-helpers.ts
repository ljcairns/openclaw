import {
  implicitMentionKindWhen,
  matchesMentionWithExplicit,
} from "openclaw/plugin-sdk/channel-inbound";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { ChannelType, type Message } from "../internal/discord.js";
import type { DiscordMessagePreflightParams } from "./message-handler.preflight.types.js";
import type { DiscordChannelInfo } from "./message-utils.js";
import { isRecentlyUnboundThreadWebhookMessage } from "./thread-bindings.js";

const DISCORD_BOUND_THREAD_SYSTEM_PREFIXES = ["⚙️", "🤖", "🧰"];
const CLAUDE_REAUTH_THREAD_NAME_RE = /^reauth-claude-/i;
const CALLBACK_CODE_STATE_RE = /\b[A-Za-z0-9]{20,}#[A-Za-z0-9_-]{20,}\b/;
// Mirrors paula-daemon parseManualAuthControlLine: claude-auth-status [paula]
// or claude-reauth [paula] [--force|force], optional leading "!".
const CLAUDE_AUTH_CONTROL_LINE_RE =
  /^!?(?:claude-auth-status(?:\s+paula)?|claude-reauth(?:\s+paula)?(?:\s+(?:--force|force))?)$/i;

function stripAuthControlMentionPrefixes(line: string): string {
  let trimmed = line.trim();
  for (let i = 0; i < 4; i += 1) {
    const next = trimmed
      .replace(/^<@!?\d+>\s*/, "")
      .replace(/^@?(?:jaume|paula)\s*[:,]?\s*/i, "")
      .trim();
    if (next === trimmed) break;
    trimmed = next;
  }
  return trimmed;
}

export function isClaudeReauthThreadName(threadName?: string | null): boolean {
  return CLAUDE_REAUTH_THREAD_NAME_RE.test(normalizeOptionalString(threadName) ?? "");
}

export function isClaudeReauthCallbackText(text?: string | null): boolean {
  return CALLBACK_CODE_STATE_RE.test(normalizeOptionalString(text) ?? "");
}

export function isClaudeAuthControlCommandText(text?: string | null): boolean {
  const normalized = normalizeOptionalString(text) ?? "";
  if (!normalized) return false;
  const lines = normalized
    .split(/\r?\n/)
    .map(stripAuthControlMentionPrefixes)
    .filter((line) => line.length > 0);
  if (lines.length === 0) return false;
  return lines.every((line) => CLAUDE_AUTH_CONTROL_LINE_RE.test(line));
}

export function shouldIgnoreClaudeReauthThreadMessage(params: {
  threadName?: string | null;
  text?: string | null;
}): boolean {
  return isClaudeReauthThreadName(params.threadName);
}

export function shouldIgnoreClaudeAuthControlMessage(params: { text?: string | null }): boolean {
  return isClaudeAuthControlCommandText(params.text);
}

export function isBoundThreadBotSystemMessage(params: {
  isBoundThreadSession: boolean;
  isBotAuthor: boolean;
  text?: string;
}): boolean {
  if (!params.isBoundThreadSession || !params.isBotAuthor) {
    return false;
  }
  const text = params.text?.trim();
  if (!text) {
    return false;
  }
  return DISCORD_BOUND_THREAD_SYSTEM_PREFIXES.some((prefix) => text.startsWith(prefix));
}

type BoundThreadLookupRecordLike = {
  webhookId?: string | null;
  metadata?: {
    webhookId?: string | null;
  };
};

function isDiscordThreadChannelType(type: ChannelType | undefined): boolean {
  return (
    type === ChannelType.PublicThread ||
    type === ChannelType.PrivateThread ||
    type === ChannelType.AnnouncementThread
  );
}

export function isDiscordThreadChannelMessage(params: {
  isGuildMessage: boolean;
  message: Message;
  channelInfo: DiscordChannelInfo | null;
}): boolean {
  if (!params.isGuildMessage) {
    return false;
  }
  const channel =
    "channel" in params.message ? (params.message as { channel?: unknown }).channel : undefined;
  return Boolean(
    (channel &&
      typeof channel === "object" &&
      "isThread" in channel &&
      typeof (channel as { isThread?: unknown }).isThread === "function" &&
      (channel as { isThread: () => boolean }).isThread()) ||
    isDiscordThreadChannelType(params.channelInfo?.type),
  );
}

export function resolveInjectedBoundThreadLookupRecord(params: {
  threadBindings: DiscordMessagePreflightParams["threadBindings"];
  threadId: string;
}): BoundThreadLookupRecordLike | undefined {
  const getByThreadId = (params.threadBindings as { getByThreadId?: (threadId: string) => unknown })
    .getByThreadId;
  if (typeof getByThreadId !== "function") {
    return undefined;
  }
  const binding = getByThreadId(params.threadId);
  return binding && typeof binding === "object"
    ? (binding as BoundThreadLookupRecordLike)
    : undefined;
}

export function resolveDiscordMentionState(params: {
  authorIsBot: boolean;
  botId?: string;
  hasAnyMention: boolean;
  isDirectMessage: boolean;
  isExplicitlyMentioned: boolean;
  mentionRegexes: RegExp[];
  mentionText: string;
  mentionedEveryone: boolean;
  referencedAuthorId?: string;
  senderIsPluralKit: boolean;
  transcript?: string;
}) {
  if (params.isDirectMessage) {
    return {
      implicitMentionKinds: [],
      wasMentioned: false,
    };
  }

  const everyoneMentioned =
    params.mentionedEveryone && (!params.authorIsBot || params.senderIsPluralKit);
  const wasMentioned =
    everyoneMentioned ||
    matchesMentionWithExplicit({
      text: params.mentionText,
      mentionRegexes: params.mentionRegexes,
      explicit: {
        hasAnyMention: params.hasAnyMention,
        isExplicitlyMentioned: params.isExplicitlyMentioned,
        canResolveExplicit: Boolean(params.botId),
      },
      transcript: params.transcript,
    });
  const implicitMentionKinds = implicitMentionKindWhen(
    "reply_to_bot",
    Boolean(params.botId) &&
      Boolean(params.referencedAuthorId) &&
      params.referencedAuthorId === params.botId,
  );

  return {
    implicitMentionKinds,
    wasMentioned,
  };
}

export function resolvePreflightMentionRequirement(params: {
  shouldRequireMention: boolean;
  bypassMentionRequirement: boolean;
}): boolean {
  if (!params.shouldRequireMention) {
    return false;
  }
  return !params.bypassMentionRequirement;
}

export function shouldIgnoreBoundThreadWebhookMessage(params: {
  accountId?: string;
  threadId?: string;
  webhookId?: string | null;
  threadBinding?: BoundThreadLookupRecordLike;
}): boolean {
  const webhookId = normalizeOptionalString(params.webhookId) ?? "";
  if (!webhookId) {
    return false;
  }
  const boundWebhookId =
    normalizeOptionalString(params.threadBinding?.webhookId) ??
    normalizeOptionalString(params.threadBinding?.metadata?.webhookId) ??
    "";
  if (boundWebhookId && webhookId === boundWebhookId) {
    return true;
  }
  const threadId = normalizeOptionalString(params.threadId) ?? "";
  if (!threadId) {
    return false;
  }
  if (params.threadBinding) {
    return true;
  }
  return isRecentlyUnboundThreadWebhookMessage({
    accountId: params.accountId,
    threadId,
    webhookId,
  });
}
