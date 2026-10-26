"""Explicit operator-run FC network acceptance probe; creates and destroys one sandbox."""
import json
import os
import shlex
from urllib.parse import urlparse
from e2b import Sandbox

url=os.environ['GATEWAY_URL'].rstrip('/')
if urlparse(url).scheme!='https':raise SystemExit('Use an HTTPS gateway')
policy=json.loads(os.environ['FC_EGRESS_CIDRS'])
if not policy:raise SystemExit('An explicit gateway-only egress allowlist is required')
# This script does not set FC_NETWORK_VERIFIED. Review the observed policy first.
probe=r'''
import socket,urllib.request,json
checks={}
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
try:
 with opener.open(GATEWAY+'/health',timeout=5) as r:checks['gateway']=r.status==200
except Exception:checks['gateway']=False
for name,host,port in [('internet','1.1.1.1',443),('metadata','169.254.169.254',80),('aliyun_metadata','100.100.100.200',80)]:
 try:
  s=socket.create_connection((host,port),timeout=3);s.close();checks[name+'_blocked']=False
 except OSError:checks[name+'_blocked']=True
print(json.dumps(checks))
assert all(checks.values()),'Network acceptance failed'
'''
box=Sandbox.create(template=os.environ['FC_TEMPLATE'],timeout=90,secure=True,
    network={'allow_out':policy,'allow_public_traffic':False},
    api_key=os.environ['E2B_API_KEY'],api_url=os.environ['E2B_API_URL'],domain=os.environ['E2B_DOMAIN'])
try:
    result=box.commands.run('python3 -c '+shlex.quote('GATEWAY='+repr(url)+'\n'+probe),user='agent',timeout=30)
    print(result.stdout)
finally:
    box.kill()
