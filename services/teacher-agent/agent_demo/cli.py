import argparse
import logging
import os
import time

from .config import Settings
from .db import Database
from .storage import Blobs
from .service import Service
from .teaching import make_service, initialize_teaching


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["init-db", "serve", "worker", "tick"])
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    settings = Settings.from_env()
    settings.validate()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    db = Database(settings)
    if args.command == "init-db":
        db.initialize()
        if settings.teaching_mode:
            initialize_teaching(db)
        return
    service = make_service(settings, db, Blobs(settings))
    if args.command == "serve":
        import uvicorn
        from .api import create_app
        from .bridge import managed_bridge
        with managed_bridge(settings):
            uvicorn.run(create_app(settings, service), host="0.0.0.0", port=args.port, access_log=False)
    else:
        if settings.teaching_mode:
            if args.command != "worker":
                raise ValueError("Teaching requires the resident worker, not one-off tick")
            from .teaching_worker import run
            run(service)
            return
        from .worker import Worker
        worker = Worker(service)
        while True:
            try:
                worker.tick()
            except Exception as error:
                logging.error("Reconciliation failed: %s", type(error).__name__)
            if args.command == "tick":
                break
            time.sleep(2)


if __name__ == "__main__":
    main()
