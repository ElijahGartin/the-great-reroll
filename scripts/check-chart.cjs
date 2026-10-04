'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const chart = path.resolve(__dirname, '../deploy/helm/war-table');
function render(settings, succeeds) {
  const args = ['template', 'verify', chart, ...settings.flatMap((value) => ['--set', value])];
  const result = spawnSync('helm', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status === 0, succeeds, `${args.join(' ')}\n${result.stderr}`);
  return result.stdout;
}
const origin = 'publicOrigin=https://game.example.invalid';
const normal = render([origin], true);
assert.match(normal, /replicas: 1/);
assert.match(normal, /type: Recreate/);
assert.match(normal, /ReadWriteOncePod/);
assert.match(normal, /helm.sh\/resource-policy: keep/);
assert.match(normal, /readOnlyRootFilesystem: true/);
assert.match(normal, /runAsUser: 1000/);
assert.match(normal, /automountServiceAccountToken: false/);
assert.match(normal, /type: RuntimeDefault/);
assert.match(normal, /allowPrivilegeEscalation: false/);
assert.match(normal, /drop: \[ALL\]/);
assert.match(normal, /path: \/healthz/);
assert.match(normal, /path: \/readyz/);
assert.match(normal, /mountPath: \/data/);
assert.match(normal, /mountPath: \/tmp/);
const maintenance = render([origin, 'maintenanceMode=true'], true);
assert.match(maintenance, /replicas: 0/);
assert.match(maintenance, /kind: PersistentVolumeClaim/);
assert.match(maintenance, /helm.sh\/resource-policy: keep/);
assert.match(maintenance, /type: Recreate/);
assert.match(render([origin, 'maintenanceMode=false'], true), /replicas: 1/);
for (const invalid of ['maintenanceMode=invalid', 'replicaCount=0', 'replicaCount=2']) {
  render([origin, 'maintenanceMode=true', invalid], false);
}

const ingress = render([origin, 'ingress.enabled=true', 'ingress.host=game.example.invalid', 'ingress.tlsSecretName=game-tls'], true);
assert.match(ingress, /kind: Ingress/);
const existing = render([origin, 'persistence.existingClaim=restored-rooms'], true);
assert.doesNotMatch(existing, /kind: PersistentVolumeClaim/);
assert.match(existing, /claimName: restored-rooms/);
const policy = render([origin, 'networkPolicy.enabled=true', 'networkPolicy.ingressNamespaceLabels.team=edge', 'networkPolicy.ingressPodLabels.app=controller'], true);
assert.match(policy, /egress: \[\]/);
for (const invalid of [[], ['publicOrigin=http://game.example.invalid'], ['publicOrigin=https://game.example.invalid:99999'], [origin, 'replicaCount=2'], [origin, 'persistence.accessMode=ReadWriteMany'], [origin, 'roomTtlDays=0'], [origin, 'maxRooms=0'], [origin, 'maxCommandsPerRoom=0'], [origin, 'maxBodyBytes=-1'], [origin, 'rateLimitPerMinute=0'], [origin, 'resources.limits.memory=garbage'], [origin, 'ingress.enabled=true'], [origin, 'ingress.enabled=true', 'ingress.host=wrong.example.invalid', 'ingress.tlsSecretName=tls'], [origin, 'networkPolicy.enabled=true']]) render(invalid, false);
const digest = `sha256:${'a'.repeat(64)}`;
const gitops = render([origin, 'application=war-table', 'environment=test', 'mode=single', 'autoSync=false', 'updatedBy=jenkins', 'chartVersion=1.0.0', 'images.app.repository=registry.example.invalid/platform/war-table', `images.app.digest=${digest}`, 'scheduling.default.nodeSelector.tier=general', 'scheduling.default.priorityClassName=apps', 'scheduling.default.tolerations[0].key=dedicated', 'scheduling.default.tolerations[0].operator=Exists', 'scheduling.default.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].key=tier', 'scheduling.default.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].operator=Exists'], true);
assert.match(gitops, new RegExp(`image: "registry.example.invalid/platform/war-table@${digest}"`));
assert.match(gitops, /nodeSelector:\s+tier: general/);
assert.match(gitops, /priorityClassName: "apps"/);
assert.match(gitops, /tolerations:\s+- key: dedicated/);
assert.match(gitops, /nodeAffinity:/);
assert.match(gitops, /prometheus.io\/path: \/metrics/);
assert.match(gitops, /prometheus.io\/port: "3000"/);
assert.match(render([origin, 'scheduling.nodeSelector.tier=fallback'], true), /nodeSelector:\s+tier: fallback/);
render([origin, 'images.app.digest=not-a-digest'], false);
render([origin, 'mode=blue-green'], false);
console.log('Helm rendering and unsafe configuration rejection checks passed.');
