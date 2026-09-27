import { DecimalPipe, PercentPipe } from '@angular/common';
import { Component, inject } from '@angular/core';
import { Restart } from './restart';
import ServerPage from './server';

/** A server's Overview section: what its card shows, and with the mod, countdown restarts. */
@Component({
  selector: 'app-server-overview',
  imports: [DecimalPipe, PercentPipe, Restart],
  template: `
    @let c = server.card()!;
    <dl class="grid max-w-md grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
      @if (c.features.tps) {
        <dt class="text-muted-foreground">TPS</dt>
        <dd>{{ c.tps === null ? '–' : (c.tps | number: '1.1-1') }}</dd>
      }
      <dt class="text-muted-foreground">Players</dt>
      <dd data-players>{{ c.players.length ? c.players.join(', ') : 'none' }}</dd>
      <dt class="text-muted-foreground">Uptime 24 h</dt>
      <dd>{{ c.uptimeDay === null ? 'unknown' : (c.uptimeDay | percent: '1.0-1') }}</dd>
    </dl>
    @if (c.features.chat) {
      <section class="mt-6 max-w-3xl rounded-lg border p-4">
        <h2 class="mb-2 text-sm font-semibold">Countdown restart</h2>
        <app-restart [serverId]="c.id" [pending]="c.restart" (changed)="server.refresh()" />
      </section>
    }
  `,
})
export default class Overview {
  protected readonly server = inject(ServerPage);
}
