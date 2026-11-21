/**
 * The Library page's pure rules: a pack's name and version guessed from its zip's file name, and the GitHub Actions
 * artifact link the hub accepts. The page itself is `library.ts`.
 */

/** A GitHub Actions artifact's page, as the hub accepts it. */
export const ARTIFACT = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+\/artifacts\/\d+\/?$/;

/** A pack's name and version from its zip's file name ("GT_New_Horizons_2.7.4_Server_Java_17-21.zip"): a guess to correct. */
export function fromFileName(file: string): { name: string; version: string } {
  const base = file.split(/[/?#]/).filter(Boolean).at(-1)?.replace(/\.zip$/i, '') ?? '';
  const m = /\d+\.\d+(?:\.\d+)*(?:-(?:beta|rc|pre)(?:[-.]?\d+)*)?/i.exec(base);
  if (!m) return { name: base.replace(/[_-]+/g, ' ').trim(), version: '' };
  return { name: base.slice(0, m.index).replace(/[_-]+/g, ' ').trim(), version: m[0] };
}
