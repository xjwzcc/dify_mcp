"""Network-isolated relay: loopback HTTP -> the single mounted scoped Unix socket."""
import socket
import socketserver
import threading
from main import main


class Relay(socketserver.BaseRequestHandler):
    def handle(self):
        upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        upstream.connect('/gateway.sock')
        def copy(source, target):
            try:
                while data := source.recv(65536):
                    target.sendall(data)
            except OSError:
                pass
            finally:
                try: target.shutdown(socket.SHUT_WR)
                except OSError: pass
        sender=threading.Thread(target=copy,args=(self.request,upstream),daemon=True)
        sender.start(); copy(upstream,self.request); upstream.close()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address=True
    daemon_threads=True


server=Server(('127.0.0.1',8080),Relay)
threading.Thread(target=server.serve_forever,daemon=True).start()
main()
