{{- define "war-table.name" -}}
{{- printf "%s-war-table" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- define "war-table.labels" -}}
app.kubernetes.io/name: war-table
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
{{- define "war-table.claim" -}}
{{- default (include "war-table.name" .) .Values.persistence.existingClaim -}}
{{- end -}}
