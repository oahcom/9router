const server = Bun.serve({
  port: 0,
  fetch() {
    return new Promise(() => {});
  },
});
console.log(`READY ${server.port}`);
