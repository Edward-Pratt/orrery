// CI's hub job preloads this into every test process (`NODE_OPTIONS=--import ./test/hang-report.ts`, #566): a process
// still alive after 4 minutes prints what keeps it alive (`process.getActiveResourcesInfo()`: timers, sockets,
// servers) and its file, before the step's SIGINT at 5 minutes has node --test name the files still running. Its
// timer is unref'd, so it keeps nothing alive itself; a run that ends in time prints nothing.

setTimeout(() => {
  process.stderr.write(`[hang-report] ${process.argv.slice(1).join(' ')} still running, kept alive by ${JSON.stringify(process.getActiveResourcesInfo())}\n`);
}, 240_000).unref();
