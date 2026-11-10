import json
from pathlib import Path

import pytest

from agent_demo.capabilities import Registry


def registry(tmp_path):
    skill = tmp_path/'skills/teaching-assistant'
    skill.mkdir(parents=True)
    (skill/'SKILL.md').write_text('查询当前课程的学生进度。', encoding='utf-8')
    path = tmp_path/'capabilities.json'
    path.write_text(json.dumps({'profiles':{'hotel-teacher':{'skills':['teaching-assistant'], 'tools':[]}},
                               'skills':{'teaching-assistant':'skills/teaching-assistant'}, 'tools':{}}))
    return Registry(path), skill


def freeze(value):
    return value.freeze('hotel-teacher', ['teaching-assistant'], {'profiles':['hotel-teacher']})


def test_appledouble_and_cache_files_do_not_become_skill_instructions(tmp_path):
    value, skill = registry(tmp_path)
    # Same binary prefix and invalid byte position as the production archive.
    sidecar = b'\x00\x05\x16\x07'+b'\x00'*41+b'\xa3'
    for relative in ['._SKILL.md', '.DS_Store', '__MACOSX/._notes.md', '__pycache__/helper.pyc']:
        path = skill/relative
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(sidecar)
    (skill/'notes.md').write_text('只读分析，不修改成绩。', encoding='utf-8')
    files = freeze(value)['skills'][0]['files']
    assert files == {'SKILL.md':'查询当前课程的学生进度。', 'notes.md':'只读分析，不修改成绩。'}


def test_real_invalid_skill_text_still_fails_without_lossy_decoding(tmp_path):
    value, skill = registry(tmp_path)
    (skill/'SKILL.md').write_bytes(b'\xff')
    with pytest.raises(ValueError, match='^SKILL_FILE_NOT_UTF8$'):
        freeze(value)


def test_skill_symlinks_remain_forbidden_even_for_metadata(tmp_path):
    value, skill = registry(tmp_path)
    outside = tmp_path/'outside'; outside.write_text('outside')
    (skill/'._hidden').symlink_to(outside)
    with pytest.raises(ValueError, match='Skill symlinks are forbidden'):
        freeze(value)
