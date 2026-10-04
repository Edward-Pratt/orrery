import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { LibraryState, NewServerAnswer, NewServerRequest, StartScript, StartScripts } from '@hub/api';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmSheetImports } from '@spartan-ng/helm/sheet';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { firstValueFrom } from 'rxjs';
import { Feedback } from '../feedback';

/** The hub's rules for a new server (`packs.ts`), checked here first so the form says what's wrong. */
const ID = /^[a-z][a-z0-9-]{0,31}$/;
const MEMORY = /^[1-9]\d{0,5}[MG]$/;

/**
 * New server: a full-height sheet asking for the id, name, game port, memory, pack version (from the library), its
 * start script, the Java runtime (the newest by default; System java) and the EULA tick. A looping start script
 * pre-ticks the Config edit that removes the loop. `started` once the hub took it (the install runs in the background).
 */
@Component({
  selector: 'app-new-server',
  imports: [RouterLink, HlmButton, HlmInput, HlmSheetImports, HlmSpinner],
  template: `
    <hlm-sheet side="right" state="open" (closed)="closed.emit()">
      <hlm-sheet-content *hlmSheetPortal="let ctx" class="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md" data-sheet>
        <hlm-sheet-header>
          <h2 hlmSheetTitle>New server</h2>
        </hlm-sheet-header>
        <div class="flex flex-col gap-3 px-4 pb-4 text-sm">
          <div class="grid grid-cols-2 gap-2">
            <label
              >Id <input hlmInput class="mt-1 w-full font-mono" placeholder="creative" [value]="id()" (input)="id.set($any($event.target).value.trim())" data-id
            /></label>
            <label>Name <input hlmInput class="mt-1 w-full" placeholder="Creative" [value]="name()" (input)="name.set($any($event.target).value)" data-name /></label>
            <label
              >Game port
              <input hlmInput type="number" min="1" max="65535" class="mt-1 w-full" [value]="port()" (input)="port.set(+$any($event.target).value)" data-port
            /></label>
            <label>Memory <input hlmInput class="mt-1 w-full" placeholder="6G" [value]="memory()" (input)="memory.set($any($event.target).value.trim())" data-memory /></label>
          </div>
          @if (id() && !idOk()) {
            <p class="text-xs text-status-down" data-id-error>The id is a lowercase letter, then up to 31 lowercase letters, digits or dashes: it names the unit and the folder.</p>
          }
          @if (memory() && !memoryOk()) {
            <p class="text-xs text-status-down" data-memory-error>Memory is a size like 6G or 512M.</p>
          }
          @if (library(); as lib) {
            @if (lib.packs.length) {
              <label
                >Pack version
                <select class="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm" [value]="pack() ?? ''" (change)="pickPack(+$any($event.target).value || null)" data-pick>
                  <option value="">Choose a version…</option>
                  @for (e of lib.packs; track e.id) {
                    <option [value]="e.id">{{ e.name }} {{ e.version }} · Minecraft {{ e.mc }}</option>
                  }
                </select>
              </label>
            } @else {
              <p class="text-muted-foreground" data-library-empty>The library has no pack versions yet.</p>
            }
            <p class="text-xs text-muted-foreground">Not there? <a routerLink="/library" class="underline">Add it on the Library page</a> first.</p>
            @if (scripts(); as list) {
              <label
                >Start script
                <select class="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm" (change)="pickScript($any($event.target).value)" data-script>
                  @for (s of list; track s.name) {
                    <option [value]="s.name" [selected]="s.name === script()">{{ s.name }}</option>
                  }
                </select>
              </label>
              @if (chosen() && !chosen()!.memory) {
                <p class="text-xs text-status-down" data-no-memory>This script sets no -Xmx or -Xms, so the memory can't be set: pick another.</p>
              }
              @if (!list.length) {
                <p class="text-xs text-status-down" data-no-scripts>This pack has no start script (*.sh) at its top.</p>
              }
              @if (loops()) {
                <label class="flex items-start gap-2">
                  <input type="checkbox" class="mt-0.5 size-4 accent-[var(--brand)]" [checked]="removeLoop()" (change)="removeLoop.set(!removeLoop())" data-loop />
                  <span>Remove its <code>while true</code> restart loop (a Config edit): systemd restarts the server, and the loop would make a stop hang.</span>
                </label>
              }
            }
            <label
              >Java runtime
              <select class="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm" (change)="runtime.set($any($event.target).value)" data-runtime>
                @for (r of lib.runtimes; track r.name) {
                  <option [value]="r.name" [selected]="r.name === runtime()">{{ r.label }}</option>
                }
                <option value="" [selected]="runtime() === ''">System java</option>
              </select>
            </label>
          }
          <label class="flex items-start gap-2">
            <input type="checkbox" class="mt-0.5 size-4 accent-[var(--brand)]" [checked]="eula()" (change)="eula.set(!eula())" data-eula />
            <span>I accept the <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noopener" class="underline">Minecraft EULA</a></span>
          </label>
          <button hlmBtn [disabled]="busy() || !ready()" (click)="create()" data-go>
            @if (busy()) {
              <hlm-spinner />
            }
            Install
          </button>
          <p class="text-xs text-muted-foreground">
            The hub installs the pack into its own servers folder, then lists the server as Waiting for setup with the one command to run as root.
          </p>
        </div>
      </hlm-sheet-content>
    </hlm-sheet>
  `,
})
export class NewServer {
  readonly #http = inject(HttpClient);
  readonly #feedback = inject(Feedback);
  readonly closed = output<void>();
  readonly started = output<string>();

  protected readonly library = signal<LibraryState | null>(null);
  protected readonly id = signal('');
  protected readonly name = signal('');
  protected readonly port = signal(25565);
  protected readonly memory = signal('6G');
  protected readonly pack = signal<number | null>(null);
  protected readonly scripts = signal<StartScript[] | null>(null);
  protected readonly script = signal<string | null>(null);
  protected readonly removeLoop = signal(false);
  /** A runtime's name; '' for system java. */
  protected readonly runtime = signal('');
  protected readonly eula = signal(false);
  protected readonly busy = signal(false);

  protected readonly idOk = computed(() => ID.test(this.id()));
  protected readonly memoryOk = computed(() => MEMORY.test(this.memory()));
  protected readonly chosen = computed(() => this.scripts()?.find((s) => s.name === this.script()));
  protected readonly loops = computed(() => this.chosen()?.loops ?? false);
  readonly ready = computed(
    () =>
      this.idOk() &&
      !!this.name().trim() &&
      Number.isInteger(this.port()) &&
      this.port() >= 1 &&
      this.port() <= 65535 &&
      this.memoryOk() &&
      this.pack() !== null &&
      !!this.chosen()?.memory &&
      this.eula(),
  );

  constructor() {
    void firstValueFrom(this.#http.get<LibraryState>('/api/library')).then(
      (lib) => {
        this.library.set(lib);
        this.runtime.set(lib.runtimes[0]?.name ?? ''); // newest first
      },
      (err: HttpErrorResponse) => this.#feedback.failed('Reading the library', err),
    );
  }

  protected async pickPack(id: number | null): Promise<void> {
    this.pack.set(id);
    this.scripts.set(null);
    this.script.set(null);
    if (id === null) return;
    try {
      const { scripts } = await firstValueFrom(this.#http.get<StartScripts>(`/api/library/packs/${id}/scripts`));
      if (this.pack() !== id) return;
      this.scripts.set(scripts);
      // A looping script is the likely server one (GTNH's startserver-java9.sh).
      this.pickScript((scripts.find((s) => s.loops && s.memory) ?? scripts.find((s) => s.memory) ?? scripts[0])?.name ?? null);
    } catch (err) {
      if (err instanceof HttpErrorResponse) this.#feedback.failed('Reading its start scripts', err);
      else throw err;
    }
  }

  protected pickScript(name: string | null): void {
    this.script.set(name);
    this.removeLoop.set(this.loops());
  }

  protected async create(): Promise<void> {
    const body: NewServerRequest = {
      id: this.id(),
      name: this.name().trim(),
      gamePort: this.port(),
      memory: this.memory(),
      library: this.pack()!,
      startScript: this.script()!,
      runtime: this.runtime() || null,
      eula: this.eula(),
      removeLoop: this.loops() && this.removeLoop(),
    };
    this.busy.set(true);
    try {
      const { id } = await firstValueFrom(this.#http.post<NewServerAnswer>('/api/servers', body));
      this.started.emit(id);
    } catch (err) {
      if (err instanceof HttpErrorResponse) this.#feedback.failed(`Installing ${body.name}`, err);
      else throw err;
    } finally {
      this.busy.set(false);
    }
  }
}
