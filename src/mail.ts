/**
 * Pure helpers about messages for the lead, shared by the host and the browser half (no imports).
 * @module dsh-agent-scheduler/mail
 */

/**
 * A message for the lead in one line: its body without the scheduler's bracketed header line,
 * whitespace collapsed, cut to `max` characters.
 * @param text - the message.
 * @param max - at most this many characters (an ellipsis marks a cut).
 * @returns the preview.
 */
export function mailPreview(text: string, max = 120): string {
  const newline = text.indexOf('\n')
  const body = text.startsWith('[') && newline > 0 && text.slice(newline + 1).trim() !== '' ? text.slice(newline + 1) : text
  const flat = body.replace(/\s+/gu, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
