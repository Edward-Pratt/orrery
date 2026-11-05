// The orrery mark: a teal sun inside a tilted orbit, with two planets on it. Sized by the caller's classes on the
// host; colours follow the app's theme. `animated` sends both planets round the orbit, half a lap apart (the login
// card), and stops under reduced motion. `public/favicon.svg` draws the same shape with fixed colours: change both together.

import { Component, input } from '@angular/core';

@Component({
  selector: 'app-logo',
  host: { class: 'inline-block shrink-0', 'aria-hidden': 'true' },
  template: `
    <svg viewBox="0 0 32 32" class="size-full overflow-visible">
      <g transform="rotate(-25 16 16)">
        <ellipse cx="16" cy="16" rx="13.5" ry="6" fill="none" stroke-width="2" class="stroke-brand/45" />
        <circle cx="16" cy="16" r="5.5" class="fill-brand" />
        @if (animated()) {
          <circle r="3.2" class="planet fill-amber-500" />
          <circle r="1.8" class="planet far fill-orange-500" />
        } @else {
          <circle cx="5.2" cy="19.6" r="3.2" class="fill-amber-500" />
          <circle cx="27.4" cy="12.8" r="1.8" class="fill-orange-500" />
        }
      </g>
    </svg>
  `,
  styles: `
    .planet {
      offset-path: path('M 5.2 19.6 A 13.5 6 0 0 1 26.8 12.4 A 13.5 6 0 0 1 5.2 19.6 Z');
      offset-rotate: 0deg;
    }
    .far {
      offset-distance: 50%;
    }
    @media (prefers-reduced-motion: no-preference) {
      .planet {
        animation: orbit 12s linear infinite;
      }
      .far {
        animation-delay: -6s;
      }
    }
    @keyframes orbit {
      from {
        offset-distance: 0%;
      }
      to {
        offset-distance: 100%;
      }
    }
  `,
})
export class Logo {
  readonly animated = input(false);
}
