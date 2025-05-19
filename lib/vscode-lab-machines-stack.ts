import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as crypto from 'crypto';

interface VscodeLabMachinesStackProps extends cdk.StackProps {
  ec2InstanceType: cdk.aws_ec2.InstanceType;
  ec2InstanceCount: number;
  allowedIps: string[];
  domainName: string;
}

const machineImage = cdk.aws_ec2.MachineImage.genericLinux({
  'us-east-2': 'ami-04f167a56786e4b09'
});

export class VscodeLabMachinesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: VscodeLabMachinesStackProps) {
    super(scope, id, props);

    const hostedZone = cdk.aws_route53.HostedZone.fromLookup(
      this,
      'HostedZone',
      {
        domainName: props.domainName,
      }
    );

    const vpc = new cdk.aws_ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'PublicSubnet',
          subnetType: cdk.aws_ec2.SubnetType.PUBLIC,
        },
      ],
    });

    const securityGroup = new cdk.aws_ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc,
      description: 'Security group for VSCode Lab Machines',
    });

    props.allowedIps.forEach((ip, index) => {
      securityGroup.addIngressRule(
        cdk.aws_ec2.Peer.ipv4(ip),
        cdk.aws_ec2.Port.tcp(443),
        `Allow HTTPS access from ${ip}`
      );
    });

    const role = new cdk.aws_iam.Role(this, 'Ec2Role', {
      assumedBy: new cdk.aws_iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    const userData = cdk.aws_ec2.UserData.forLinux();
    userData.addCommands(
      'curl -fOL https://github.com/coder/code-server/releases/download/v4.100.2/code-server_4.100.2_amd64.deb',
      'dpkg -i code-server_4.100.2_amd64.deb',
      'hostnamectl set-hostname kubectl-labs-machine',
      "setcap 'cap_net_bind_service=+ep' /usr/lib/code-server/lib/node",
      "echo -e '#!/usr/bin/env sh\\n\\nexec /usr/lib/code-server/bin/code-server \"\\$@\" --auth none --cert --bind-addr 0.0.0.0:443' | sudo tee /usr/bin/code-server && sudo chmod +x /usr/bin/code-server",
      'useradd -m -s /bin/bash student',
      'echo "student ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/student',
      'chmod 0440 /etc/sudoers.d/student',
      'mkdir -p /home/student',
      'apt update -y',
      'yum update -y',
      'yum install -y git',
      'curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"',
      'chmod +x ./kubectl',
      'mv ./kubectl /usr/local/bin/kubectl',
      'apt-get install docker.io -y',
      'usermod -aG docker student',
      'cd /home/student && git clone https://github.com/rileydakota/minikube-security-lab.git',
      'chown -R student:student /home/student/minikube-security-lab',
      'curl -LO https://github.com/kubernetes/minikube/releases/latest/download/minikube-linux-amd64',
      'install minikube-linux-amd64 /usr/local/bin/minikube && rm minikube-linux-amd64',
      'snap install task --classic',
      'snap install helm --classic',
      'systemctl enable docker',
      'systemctl start docker',
      'systemctl enable code-server@student',
      'systemctl start code-server@student'
    );

    const ec2Instances = Array.from({ length: props.ec2InstanceCount }, (_, i) => {
      // Generate a deterministic subdomain based on stack name and instance number
      const subdomainSeed = `${this.stackName}-instance-${i + 1}`;
      const subdomain = crypto.createHash('sha256').update(subdomainSeed).digest('hex').slice(0, 12);

      const instance = new cdk.aws_ec2.Instance(this, `Ec2Instance${i + 1}`, {
        instanceType: props.ec2InstanceType,
        machineImage: machineImage,
        vpc,
        vpcSubnets: { subnetType: cdk.aws_ec2.SubnetType.PUBLIC },
        securityGroup,
        role,
        associatePublicIpAddress: true, // Enable public IP
        userData,
        blockDevices: [
          {
            deviceName: '/dev/sda1',
            volume: cdk.aws_ec2.BlockDeviceVolume.ebs(20),
          },
        ],
      });

      
      instance.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

      new cdk.aws_route53.ARecord(this, `DnsRecord${i + 1}`, {
        zone: hostedZone,
        recordName: subdomain,
        target: cdk.aws_route53.RecordTarget.fromIpAddresses(instance.instancePublicIp),
        ttl: cdk.Duration.minutes(1),
      });

      new cdk.CfnOutput(this, `Instance${i + 1}Url`, {
        value: `https://${subdomain}.${hostedZone.zoneName}/?folder=/home/student/minikube-security-lab`,
        description: `URL for Instance ${i + 1}`,
      });

      new cdk.CfnOutput(this, `Instance${i + 1}SsmUrl`, {
        value: `https://${cdk.Stack.of(this).region}.console.aws.amazon.com/systems-manager/session-manager/${instance.instanceId}?region=${cdk.Stack.of(this).region}`,
        description: `SSM URL for Instance ${i + 1}`,
      });

      return instance;
    });

    // The code that defines your stack goes here

    // example resource
    // const queue = new sqs.Queue(this, 'VscodeLabMachinesQueue', {
    //   visibilityTimeout: cdk.Duration.seconds(300)
    // });
  }
}
