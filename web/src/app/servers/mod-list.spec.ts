import { LIST_MAX_BYTES, ModListError, MODS_MAX, parseModList, shown, validName } from './mod-list';

/** A client's `mod-list.json` as Factorio 2.1 writes it: the game's own mods first, then the portal's, some off. */
const CLIENT = JSON.stringify(
  {
    mods: [
      { name: 'base', enabled: true },
      { name: 'elevated-rails', enabled: true },
      { name: 'quality', enabled: true },
      { name: 'recycler', enabled: true },
      { name: 'space-age', enabled: false },
      { name: 'flib', enabled: true },
      { name: 'helmod', enabled: true, version: '2.0.0' },
      { name: 'Squeak Through', enabled: true },
      { name: 'RateCalculator', enabled: false },
      { name: 'even-distribution', enabled: true, version: 'latest' },
    ],
  },
  null,
  2,
);
const refused = (text: string) => {
  try {
    parseModList(text);
  } catch (err) {
    if (err instanceof ModListError) return err.message;
    throw err;
  }
  throw new Error('read');
};

describe('mod list parsing', () => {
  it("reads a client's mod-list.json: enabled portal mods only, the game's own and disabled ones apart, a version only when it is one", () => {
    expect(parseModList(CLIENT)).toEqual({
      mods: [
        { name: 'flib', version: null },
        { name: 'helmod', version: '2.0.0' },
        { name: 'Squeak Through', version: null },
        { name: 'even-distribution', version: null },
      ],
      disabled: ['RateCalculator'],
      // Off or on, the game's own are never picked.
      game: ['base', 'elevated-rails', 'quality', 'recycler', 'space-age'],
      invalid: [],
      duplicates: 0,
    });
    // An entry with no "enabled" counts as enabled; spaces around a name go.
    expect(parseModList('{"mods":[{"name":" flib "}]}').mods).toEqual([{ name: 'flib', version: null }]);
  });

  it('reads pasted names one per line or comma-separated, keeping spaces inside a name, each once', () => {
    expect(parseModList('flib, helmod\r\n\n  Squeak Through  \nflib,,base\nhelmod')).toEqual({
      mods: [
        { name: 'flib', version: null },
        { name: 'helmod', version: null },
        { name: 'Squeak Through', version: null },
      ],
      disabled: [],
      game: ['base'],
      invalid: [],
      duplicates: 2,
    });
  });

  it("sets aside names that aren't a mod's, as the Agent checks them: never sent to the hub", () => {
    const list = parseModList(['<script>alert(1)</script>', '../../etc/passwd', 'a..b', 'mods/flib', 'x'.repeat(257), 'tab\there', 'bidi‮evil', 'ok_name-1.2', "flib'; drop", 'x'.repeat(256)].join('\n'));
    expect(list.mods.map((m) => m.name)).toEqual(['ok_name-1.2', 'x'.repeat(256)]);
    expect(list.invalid).toHaveLength(8);
    expect(['flib', 'Squeak Through', 'a.b', '..', '', 'a/b', 'é'].map(validName)).toEqual([true, true, true, false, false, false, false]);
    // In the JSON too.
    expect(parseModList('{"mods":[{"name":"../x","enabled":true},{"name":"<img src=x>","enabled":true}]}').invalid).toEqual(['../x', '<img src=x>']);
  });

  it("shows a name that isn't a mod's safely: control characters and bidi overrides replaced, cut to 64", () => {
    expect(shown('bidi‮evil\u0000')).toBe('bidi�evil�');
    expect([...shown('y'.repeat(300))]).toHaveLength(64);
    expect(shown('y'.repeat(300)).endsWith('…')).toBe(true);
  });

  it("refuses what isn't a mod list: bad JSON, the wrong shape, over the size or the hub's mod cap, or nothing", () => {
    expect(refused('{"mods": [')).toBe("That isn't a mod-list.json: it isn't JSON.");
    expect(refused('{"mod": []}')).toBe('That isn\'t a mod-list.json: it has no "mods" list.');
    expect(refused('{"mods": {"flib": true}}')).toBe('That isn\'t a mod-list.json: it has no "mods" list.');
    expect(refused('{"mods": ["flib"]}')).toBe('That isn\'t a mod-list.json: mod 1 has no name, or "enabled" isn\'t true or false.');
    expect(refused('{"mods": [{"name": "flib", "enabled": "yes"}]}')).toBe('That isn\'t a mod-list.json: mod 1 has no name, or "enabled" isn\'t true or false.');
    expect(refused('{"mods": [{"name": 7}]}')).toBe('That isn\'t a mod-list.json: mod 1 has no name, or "enabled" isn\'t true or false.');
    expect(refused('{"__proto__": {"mods": []}}')).toBe('That isn\'t a mod-list.json: it has no "mods" list.');
    expect(refused(' \n ')).toBe('Nothing to import: the list is empty.');
    expect(refused('x'.repeat(LIST_MAX_BYTES + 1))).toBe("That's over 256 KiB: a mod-list.json is much smaller.");
    // Bytes, not characters: multi-byte text over the cap is refused too.
    expect(refused('é'.repeat(LIST_MAX_BYTES / 2 + 1))).toBe("That's over 256 KiB: a mod-list.json is much smaller.");
    const many = (n: number) => Array.from({ length: n }, (_, i) => `mod-${i}`).join('\n');
    expect(parseModList(many(MODS_MAX)).mods).toHaveLength(MODS_MAX);
    expect(refused(many(MODS_MAX + 1))).toBe(`That's ${MODS_MAX + 1} mods: an update takes at most ${MODS_MAX}.`);
    // Disabled and the game's own don't count against the cap.
    const json = JSON.stringify({ mods: [...Array.from({ length: MODS_MAX }, (_, i) => ({ name: `mod-${i}`, enabled: true })), { name: 'off', enabled: false }, { name: 'base', enabled: true }] });
    expect(parseModList(json).mods).toHaveLength(MODS_MAX);
  });
});
