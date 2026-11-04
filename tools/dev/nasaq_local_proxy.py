"""Local-only forwarding for the new site's independent dev web process.

HTTP bytes are forwarded without logging or examining request data.
"""
import ipaddress
import json
import select
import socket
import socketserver
import subprocess

networks = json.loads(subprocess.check_output([
    "docker", "inspect", "--format", "{{json .NetworkSettings.Networks}}", "erpdev-frappe-1",
], text=True))
target = str(ipaddress.ip_address(next(n["IPAddress"] for n in networks.values() if n.get("IPAddress"))))

class Forward(socketserver.BaseRequestHandler):
    def handle(self):
        with socket.create_connection((target, 8001), timeout=15) as remote:
            streams = [self.request, remote]
            while True:
                ready, _, _ = select.select(streams, [], [], 120)
                if not ready:
                    return
                for source in ready:
                    data = source.recv(65536)
                    if not data:
                        return
                    (remote if source is self.request else self.request).sendall(data)

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

with Server(("127.0.0.1", 8001), Forward) as server:
    print("Nasaq local forwarding ready on 127.0.0.1:8001", flush=True)
    server.serve_forever()
