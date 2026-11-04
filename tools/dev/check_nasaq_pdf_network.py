"""Read-only URL hostname diagnosis for the synthetic verification document."""
from html.parser import HTMLParser
from pathlib import Path
import socket
from urllib.parse import urlsplit

class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.hosts = {"nasaq.localhost"}
    def handle_starttag(self, tag, attrs):
        for name, value in attrs:
            if name in ("href", "src") and value:
                host = urlsplit(value).hostname
                if host:
                    self.hosts.add(host)

parser = Links()
source = Path("/tmp/nasaq-install-verification.html")
if source.exists():
    parser.feed(source.read_text())
for host in sorted(parser.hosts):
    try:
        socket.getaddrinfo(host, None)
        print(host, "DNS_OK")
    except OSError:
        print(host, "DNS_FAILED")
