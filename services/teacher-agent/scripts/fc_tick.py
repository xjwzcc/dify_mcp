"""Bounded scheduler invocation. Run under a durable external periodic scheduler."""
import os
import urllib.request

request=urllib.request.Request(os.environ['GATEWAY_URL'].rstrip('/')+'/internal/tick',
    data=b'',method='POST',headers={'Authorization':'Bearer '+os.environ['CONTROL_ADMIN_KEY']})
with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request,timeout=210) as response:
    if response.status != 200:raise SystemExit('Tick failed')
print('Reconciliation tick completed')
