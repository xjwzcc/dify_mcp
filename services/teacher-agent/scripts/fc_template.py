"""Build an FC Agent Sandbox template from an already published runner image."""
import argparse
import os
from e2b import Template


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--image',required=True)
    parser.add_argument('--name',default='agent-demo-runner')
    args=parser.parse_args()
    required=['E2B_API_KEY','E2B_API_URL','E2B_DOMAIN']
    if any(not os.getenv(k) for k in required):
        raise SystemExit('Set E2B_API_KEY, E2B_API_URL and E2B_DOMAIN')
    image=Template().from_image(args.image,username=os.getenv('REGISTRY_USERNAME'),
                                password=os.getenv('REGISTRY_PASSWORD'))
    build=Template.build(image,name=args.name,cpu_count=2,memory_mb=4096,
        api_key=os.environ['E2B_API_KEY'],api_url=os.environ['E2B_API_URL'],domain=os.environ['E2B_DOMAIN'])
    print('FC_TEMPLATE='+build.template_id)


if __name__=='__main__':main()
