const net = require('net');
const { spawn } = require('child_process');

const cwd = __dirname;
const host = '127.0.0.1';

const findAvailablePort = startPort =>
    new Promise((resolve, reject) => {
        const tryPort = port => {
            const server = net.createServer();
            server.once('error', error => {
                server.close();
                if (error && error.code === 'EADDRINUSE') return tryPort(port + 1);
                reject(error);
            });
            server.once('listening', () => {
                server.close(() => resolve(port));
            });
            server.listen(port, host);
        };
        tryPort(startPort);
    });

const prefixStream = (stream, label) => {
    let pending = '';
    stream.on('data', chunk => {
        pending += chunk.toString();
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || '';
        lines.forEach(line => {
            if (!line) return;
            process.stdout.write(`[${label}] ${line}\n`);
        });
    });
    stream.on('end', () => {
        if (pending) process.stdout.write(`[${label}] ${pending}\n`);
    });
};

const spawnNpm = (label, args, env) => {
    const child = spawn('npm', args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['inherit', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
    });
    prefixStream(child.stdout, label);
    prefixStream(child.stderr, label);
    return child;
};

const main = async () => {
    const wsPort = await findAvailablePort(Number(process.env.DEMO_WS_PORT || 8788));
    const httpPort = await findAvailablePort(Number(process.env.DEMO_HTTP_PORT || 5173));
    const wsUrl = `ws://${host}:${wsPort}`;

    process.stdout.write(`[start] mock ws port=${wsPort}\n`);
    process.stdout.write(`[start] demo http port=${httpPort}\n`);
    process.stdout.write(`[start] ws url=${wsUrl}\n`);

    const mock = spawnNpm('Mock', ['run', 'mock:raw'], {
        DEMO_WS_HOST: host,
        DEMO_WS_PORT: `${wsPort}`,
    });

    const demo = spawnNpm('Demo', ['run', 'dev:raw', '--', '--host', host, '--port', `${httpPort}`], {
        VITE_DEMO_WS_URL: wsUrl,
    });

    const shutdown = signal => {
        if (!mock.killed) mock.kill(signal);
        if (!demo.killed) demo.kill(signal);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    const exit = (label, code) => {
        process.stdout.write(`[start] ${label} exited with code ${code}\n`);
        shutdown('SIGTERM');
    };

    mock.on('exit', code => exit('mock', code));
    demo.on('exit', code => exit('demo', code));
};

main().catch(error => {
    console.error(error);
    process.exit(1);
});
