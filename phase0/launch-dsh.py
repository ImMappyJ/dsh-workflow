import subprocess, time, sys

exe = r'D:\Development Software\Deepseek Harness\DSH Desktop\DSH Desktop.exe'
cwd = r'D:\Development Software\Deepseek Harness\DSH Desktop'

# Try DETACHED_PROCESS alone (0x8)
try:
    flags = getattr(subprocess, 'DETACHED_PROCESS', 0x8)
    p = subprocess.Popen([exe], cwd=cwd, creationflags=flags, close_fds=True)
    print('DETACHED pid:', p.pid, flush=True)
    time.sleep(5)
    print('alive after 5s:', p.poll() is None, flush=True)
except Exception as e:
    print('detached failed:', repr(e), flush=True)

# Fallback: plain Popen, check survival after parent exits
try:
    p2 = subprocess.Popen([exe], cwd=cwd, close_fds=True)
    print('plain pid:', p2.pid, flush=True)
    time.sleep(5)
    print('plain alive after 5s:', p2.poll() is None, flush=True)
    if p2.poll() is None:
        print('STAYS_ALIVE_PLAIN', flush=True)
except Exception as e:
    print('plain failed:', repr(e), flush=True)
