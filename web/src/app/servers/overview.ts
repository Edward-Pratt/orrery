import { DatePipe, DecimalPipe, PercentPipe } from '@angular/common';
import { Component, inject } from '@angular/core';
import ServerPage from './server';

/** A server's Overview section: what its card shows, as of opening the page. */
@Component({
  selector: 'app-server-overview',
  imports: [DatePipe, DecimalPipe, PercentPipe],
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
      @if (c.restart; as r) {
        <dt class="text-muted-foreground">{{ r.stop ? 'Stop' : 'Restart' }}</dt>
        <dd>at {{ r.at | date: 'HH:mm' }} by {{ r.by }}</dd>
      }
    </dl>
  `,
})
export default class Overview {
  protected readonly server = inject(ServerPage);
}
