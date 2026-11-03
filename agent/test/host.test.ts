// `HostSampler` and the `/proc` readers: a real sample the hub accepts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAgentLine } from '../../hub/src/protocol.ts';
import { HostSampler, cpuTimes, loadAverages, memoryUse, procReaders, type HostReaders } from '../src/host.ts';

const STAT = (user: number, idle: number, iowait: number) =>
  `cpu  ${user} 10 20 ${idle} ${iowait} 5 5 0 7 0\ncpu0 1 2 3 4 5 6 7 8 9 10\nintr 12345\n`;
const MEMINFO = 'MemTotal:       16000000 kB\nMemFree:         1000000 kB\nMemAvailable:    4000000 kB\nBuffers:          100 kB\n';

test('reads /proc/stat, /proc/loadavg and /proc/meminfo', () => {
  assert.deepEqual(cpuTimes(STAT(100, 1000, 50)), { idle: 1050, total: 100 + 10 + 20 + 1000 + 50 + 5 + 5 });
  assert.deepEqual(loadAverages('0.12 0.34 0.56 1/234 5678\n'), [0.12, 0.34, 0.56]);
  assert.deepEqual(memoryUse(MEMINFO), { used: 12_000_000 * 1024, total: 16_000_000 * 1024 });
  assert.throws(() => cpuTimes('intr 1\n'));
  assert.throws(() => cpuTimes('cpu  1 2 x 4\n'));
  assert.throws(() => loadAverages('0.1 0.2\n'));
  assert.throws(() => memoryUse('MemTotal: 1 kB\n'), /meminfo/);
});

test('a sample is CPU use between two readings, the load, memory and each readable mount', async () => {
  const stats = [STAT(100, 1000, 0), STAT(400, 1500, 100)];
  const read: HostReaders = {
    proc: async (name) => (name === 'stat' ? stats.shift()! : name === 'loadavg' ? '1.5 1.0 0.5 2/300 99\n' : MEMINFO),
    disk: async (mount) => (mount === '/' ? { free: 5, total: 10 } : null),
  };
  const sampler = new HostSampler(['/', '/gone'], read);
  const errors: string[] = [];
  const error = console.error;
  console.error = (line: string) => errors.push(line);
  try {
    assert.equal(await sampler.sample(1), null, 'the first call is only the CPU baseline');
    const s = await sampler.sample(2);
    // 900 ticks went by (300 user + 500 idle + 100 iowait), 300 of them busy.
    assert.deepEqual(s, { ts: 2, cpu: 300 / 900, load: [1.5, 1, 0.5], memory: { used: 12_000_000 * 1024, total: 16_000_000 * 1024 }, disks: [{ mount: '/', free: 5, total: 10 }] });
  } finally {
    console.error = error;
  }
  assert.deepEqual(errors, ["[host] can't read the disk of /gone"]);
});

test('a real sample of this machine is a hostSample the hub accepts', async () => {
  const sampler = new HostSampler(['/'], procReaders);
  await sampler.sample();
  await new Promise((r) => setTimeout(r, 20));
  const sample = (await sampler.sample())!;
  assert.ok(sample.cpu >= 0 && sample.cpu <= 1 && sample.memory.total > 0 && sample.disks[0]!.total > 0);
  assert.deepEqual(parseAgentLine(JSON.stringify({ type: 'hostSample', sample })), { type: 'hostSample', sample });
});
