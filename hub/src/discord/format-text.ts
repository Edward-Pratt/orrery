// Discord output's base: `Post` = plain text or embeds, `COLORS` and `SEVERITY_COLORS`, Discord's limits, and the
// escaping every string from a game goes through: `md()` (§ codes, markdown, headings, lists and masked links), and
// `inline()` (inline markdown and masked links, not the line-start rules, which would put a backslash before a GTNH
// backup's "12.3 seconds") where text goes mid-line in an embed title; `title` (§ codes stripped, cut to 256),
// `embed`, `plain` (plain-text posts cut to 2000 characters after escaping) and `chatContent` (a relayed chat line,
// escaped and cut the same). The format modules and `format-target.ts` build on it.

import { escapeMarkdown, type APIEmbed } from 'discord.js';
import { stripCodes, truncate, type Severity } from '../servers/servers.ts';

/** What the bot posts: plain text (chat-like messages) or an embed (everything else). */
export type Post = { content: string } | { embeds: APIEmbed[] };

export const COLORS = { green: 0x2ecc71, grey: 0x95a5a6, red: 0xe74c3c, orange: 0xe67e22, blue: 0x3498db } as const;

// Discord limits: a message's content, an embed's parts.
const CONTENT = 2000;
const TITLE = 256;
export const FIELD = 1024;
export const DESCRIPTION = 4096;

/** Escapes Minecraft text for Discord: no § codes, no markdown, headings, lists or masked links. */
export function md(s: string): string {
  return escapeMarkdown(stripCodes(s), { heading: true, maskedLink: true, bulletedList: true, numberedList: true });
}

/**
 * Escapes text that goes mid-line or in an embed title (a notice's detail, a save's name, a version, an error): every
 * inline markdown and masked links, but not the line-start rules (headings, lists), which there would only put a
 * backslash before a backup's "12.3 seconds".
 */
export function inline(s: string): string {
  return escapeMarkdown(stripCodes(s), { maskedLink: true });
}

/** Embed titles render less markdown than descriptions, so they only get § codes stripped. */
export function title(s: string): string {
  return truncate(stripCodes(s), TITLE);
}

export const embed = (e: APIEmbed): Post => ({ embeds: [e] });
/** A plain-text post, cut to Discord's 2000 characters after escaping (escaping can double a 1 KiB message). */
export const plain = (s: string): Post => ({ content: truncate(s, CONTENT) });

/** A chat line as the relay webhook posts it (the name is the webhook's own): escaped, then cut to Discord's 2000. */
export function chatContent(message: string): string {
  return truncate(md(message), CONTENT);
}

export const SEVERITY_COLORS: Record<Severity, number> = { problem: COLORS.red, warning: COLORS.orange, good: COLORS.green, info: COLORS.blue };
