import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as route53 from "aws-cdk-lib/aws-route53";

export interface containerRoute53Props extends StackProps {
  stageName: string;
  albDNS: string;
}

export class containerRoute53 extends Stack {
  constructor(scope: Construct, id: string, props: containerRoute53Props) {
    super(scope, id, props);

    const stageName = props.stageName;
    const albDNS = props.albDNS;

    const zone = route53.HostedZone.fromLookup(this, 'hostedZone', {
      domainName: 'example.com'
    });

    new route53.CnameRecord(this, 'conatinerCName', {
      domainName: albDNS,
      recordName: stageName === 'prod' ? `container.example.com` : `${stageName}-container.example.com`,
      zone: zone,
    });
  }
}