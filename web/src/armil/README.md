# Armil, vendored

Edward's design system, copied in from `~/ClaudeCode/armil`. Nothing here is edited by hand.

- `css/armil.css`: built by Armil's own script, with only the icons the app draws as `ar-icon` classes (the nav's
  page icons in `app.ts`, the ThemeSwitch's sun and moon, and the console's star and close). Every other icon is an
  SVG string in `icons.ts`, so the stylesheet does not carry it. From `web/`:

  ```sh
  node ../../armil/dist/build.mjs --out src/armil/css/armil.css --icons check,close,cpu,layers,library,logs,moon,server,star,sun,users
  ```

  The same flags always give the same bytes. Built on 18 November 2026 from Armil source `6341863a8d9b` (the hash in
  the file's first line): 70682 bytes, sha256 `96136253dd66727327c3a036019e1bcd79763fe3f4c5b37b884a090a176d13b5`.
  Rebuild after Armil's `tokens.json` or `components/bundle.css` changes, and when an `ar-icon--<name>` class is added
  to or dropped from the app (`chevron-down` and `check` are always kept).
- `fonts/`: Armil's whole `fonts/` folder, with the licences from `assets/Licences/` beside the font files.
- `icons.ts`: the icons registered with ng-icons, each copied from Armil's `icons/icons.json`.
