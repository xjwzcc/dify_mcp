import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('ecs_agent_deploy', Path(__file__).resolve().parents[1]/'deploy/ecs-agent-deploy.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class EnvironmentTest(unittest.TestCase):
    def test_release_copy_excludes_metadata_and_preserves_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)/'source'; source.mkdir()
            (source/'SKILL.md').write_text('中文教学说明', encoding='utf-8')
            (source/'native').write_bytes(b'\x7fELF\xff\x00')
            (source/'native').chmod(0o755)
            (source/'binary-link').symlink_to('native')
            for name in ['._SKILL.md', '.DS_Store', 'cache.pyc']:
                (source/name).write_bytes(b'\x00\xa3')
            (source/'__MACOSX').mkdir(); (source/'__MACOSX/sidecar').write_bytes(b'\xa3')
            target = Path(directory)/'release'
            deploy.copy_release(source, target)
            self.assertEqual(sorted(p.name for p in target.iterdir()), ['SKILL.md', 'binary-link', 'native'])
            self.assertEqual((target/'SKILL.md').read_text(encoding='utf-8'), '中文教学说明')
            self.assertEqual((target/'native').read_bytes(), b'\x7fELF\xff\x00')
            self.assertEqual((target/'native').stat().st_mode & 0o777, 0o755)
            self.assertTrue((target/'binary-link').is_symlink())

    def test_external_service_shares_only_scoped_keys_with_web(self):
        live = {'DEEPSEEK_API_KEY': 'private-model-key', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET': 'cloud-secret',
                'PYTHONPATH': '/untrusted', 'TEACHER_AGENT_MAX_ACTIVE': '30'}
        web, control = deploy.environments(live, Path('/opt/shixunlab/releases/check'))
        self.assertNotIn('DEEPSEEK_API_KEY', web)
        self.assertNotIn('ALIBABA_CLOUD_ACCESS_KEY_SECRET', control)
        self.assertEqual(control['TEACHING_VERIFY_KEY'], web['AGENT_SIGNING_KEY'])
        self.assertEqual(control['TEACHING_TOOL_SIGNING_KEY'], web['AGENT_TOOL_VERIFY_KEY'])
        self.assertEqual(control['AGENT_PERSISTENCE_KEY'], web['AGENT_PERSISTENCE_KEY'])
        self.assertEqual(control['MAX_ACTIVE_EXECUTIONS'], '1')
        self.assertNotIn('/untrusted', control['PYTHONPATH'])
        self.assertEqual(control['DEEPSEEK_API_KEY'], 'private-model-key')
        self.assertEqual(web['TEACHER_AGENT_MODE'], 'ecs-external')

    def test_env_file_is_private_and_rejects_newline_injection(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)/'control.env'
            deploy.write_env(target, {'KEY': 'quoted"value\\suffix'})
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(ValueError):
                deploy.write_env(target, {'KEY': 'value\nLD_PRELOAD=other'})


if __name__ == '__main__':
    unittest.main()
