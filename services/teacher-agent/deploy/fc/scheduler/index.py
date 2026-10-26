"""FC timer handler: reconciliation runs only while this invocation is active."""
import os
import time
import urllib.request


def handler(event, context):
    deadline=time.monotonic()+45
    count=0
    while True:
        start=time.monotonic()
        req=urllib.request.Request(os.environ['GATEWAY_URL'].rstrip('/')+'/internal/tick',
            data=b'',method='POST',headers={'Authorization':'Bearer '+os.environ['CONTROL_ADMIN_KEY']})
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req,timeout=210) as response:
            if response.status!=200:raise RuntimeError('Reconciliation failed')
        count+=1
        if time.monotonic()>=deadline:return {'ticks':count}
        time.sleep(max(0,min(10-(time.monotonic()-start),deadline-time.monotonic())))
