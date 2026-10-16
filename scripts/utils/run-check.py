#!/usr/bin/env python3
"""Bound a verification command and terminate its process group on timeout."""
import os
import signal
import subprocess
import sys

process = subprocess.Popen(['bash', '-c', sys.argv[1]], start_new_session=True)
try:
    raise SystemExit(process.wait(timeout=20))
except subprocess.TimeoutExpired:
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    print('Verification timed out after 20 seconds', file=sys.stderr)
    raise SystemExit(124)
