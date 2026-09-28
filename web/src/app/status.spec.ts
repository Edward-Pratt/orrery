import { TestBed } from '@angular/core/testing';
import { Status } from './status';

describe('Status', () => {
  it('shows a word beside the dot, so colour is never the only signal', () => {
    const f = TestBed.createComponent(Status);
    f.componentRef.setInput('health', 'down');
    f.componentRef.setInput('label', 'Offline');
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Offline');
    expect(el.querySelector('.bg-status-down')).not.toBeNull();
  });
});
