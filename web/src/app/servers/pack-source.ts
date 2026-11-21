import { Component, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { LibraryState } from '@hub/api';

/**
 * The library picker of the Pack tab's Adopt and Update pack: the library's pack versions to choose from (or a line
 * that it has none), and a link to the Library page for one that isn't there. It only picks: `pickChange` says which.
 */
@Component({
  selector: 'app-pack-source',
  host: { class: 'contents' },
  imports: [RouterLink],
  template: `
    @if (library()?.packs; as packs) {
      @if (packs.length) {
        <label
          >Pack version
          <select class="ar-input mt-1 w-full" [value]="pick() ?? ''" (change)="pickChange.emit(+$any($event.target).value || null)" data-pick>
            <option value="">Choose a version…</option>
            @for (e of packs; track e.id) {
              <option [value]="e.id">{{ e.name }} {{ e.version }} · Minecraft {{ e.mc }}</option>
            }
          </select>
        </label>
      } @else {
        <p class="text-muted-foreground" data-library-empty>The library has no pack versions yet.</p>
      }
    }
    <p class="text-xs text-muted-foreground">Not there? <a routerLink="/library" class="underline" data-library-link>Add it on the Library page</a> first.</p>
  `,
})
export class PackSource {
  readonly library = input.required<LibraryState | null>();
  readonly pick = input.required<number | null>();
  readonly pickChange = output<number | null>();
}
