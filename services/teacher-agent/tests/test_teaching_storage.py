from dataclasses import replace
import hashlib
import json

import pytest

from agent_demo.storage import Blobs, InputError


def test_native_oss_uses_private_dedicated_prefix_and_checks_integrity(service, monkeypatch):
    s = replace(service.s, blob_backend='oss', oss_bucket='agent-only', oss_endpoint='https://oss.example.test')
    blobs = Blobs(s)
    objects = {}
    class Bucket:
        def put_object(self, key, value, headers):
            assert key.startswith('teacher-agent/v1/')
            assert headers['x-oss-object-acl'] == 'private'
            assert headers['x-oss-forbid-overwrite'] == 'true'
            objects[key] = value
        def get_object(self, key):
            from io import BytesIO
            return BytesIO(objects[key])
    monkeypatch.setattr(blobs, 'oss_bucket', lambda: Bucket())
    ref = blobs.put('老师'.encode())
    assert blobs.get(ref) == '老师'.encode()
    assert ref['sha256'] == hashlib.sha256('老师'.encode()).hexdigest()
    objects['teacher-agent/v1/' + ref['blob']] = b'bad'
    with pytest.raises(InputError, match='integrity'):
        blobs.get(ref)
    with pytest.raises(InputError, match='Invalid blob'):
        blobs.get({**ref, 'blob': '../other'})


def test_production_refuses_ephemeral_database(service):
    s = replace(service.s, production=True, teaching_mode=True, teaching_url='https://teaching.example.test',
        teaching_verify_key='v'*32, teaching_tool_key='t'*32, teaching_deployment='prod')
    with pytest.raises(ValueError, match='independent MySQL'):
        s.validate()
