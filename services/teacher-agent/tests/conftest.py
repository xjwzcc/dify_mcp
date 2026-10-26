from pathlib import Path
import pytest
from agent_demo.config import Settings
from agent_demo.db import Database
from agent_demo.storage import Blobs
from agent_demo.service import Service

@pytest.fixture
def service(tmp_path):
    s = Settings(database_url='sqlite:///' + str(tmp_path / 'db.sqlite'), data_dir=tmp_path,
        registry_path=Path(__file__).parents[1] / 'config/capabilities.json',
        api_keys={'a' * 32: {'tenant': 'a', 'profiles': ['default']},
                  'b' * 32: {'tenant': 'b', 'profiles': ['default']}},
        bridge_secret='s' * 32, deepseek_key='test-provider-secret')
    db = Database(s)
    db.initialize()
    yield Service(s, db, Blobs(s))
    db.engine.dispose()

@pytest.fixture
def principal():
    return {'tenant': 'a', 'profiles': ['default']}

class FakeSandbox:
    def __init__(self):
        self.boxes, self.specs, self.destroyed = {}, {}, []
    def create(self, attempt):
        self.boxes[attempt['id']] = None
        return attempt['id']
    def start(self, sid, spec, files):
        self.specs[sid] = (spec, files)
    def inspect(self, sid):
        return self.boxes[sid]
    def destroy(self, attempt):
        self.destroyed.append(attempt['id'])
        self.boxes.pop(attempt['id'], None)

@pytest.fixture
def backend():
    return FakeSandbox()
