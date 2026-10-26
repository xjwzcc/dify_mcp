"""Single-process FC control composition root; everything is loopback-only."""
import logging
import uvicorn
from .config import Settings
from .fc_storage import FcDatabase
from .storage import Blobs
from .teaching import make_service, initialize_teaching
from .internal_sandbox import InternalProvider
from .internal_runtime import InternalRuntime
from .bridge import managed_bridge
from .api import create_app


def main():
    logging.basicConfig(level=logging.WARNING)
    settings=Settings.from_env(); settings.validate()
    provider = InternalProvider(settings)
    provider.recover_workspaces()
    provider.preflight()
    db=FcDatabase(settings); db.initialize(); initialize_teaching(db)
    service=make_service(settings,db,Blobs(settings))
    runtime=InternalRuntime(service)
    with managed_bridge(settings):
        db.start_writer()
        runtime.start()
        try:
            uvicorn.run(create_app(settings,service),host='127.0.0.1',port=9181,access_log=False)
        finally:
            runtime.close()
            db.close_writer()


if __name__=='__main__':
    main()
