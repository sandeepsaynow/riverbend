#!/usr/bin/env bash
# Emits the Cloud Run worker + LiteLLM sidecar service YAML (worker -> localhost:4000). Driven by env vars
# set by riverbend-gcp.sh: ENV_SUB_IMG_APP, ENV_SUB_IMG_LLM, ENV_SUB_CONN, ENV_SUB_WMIN.
set -euo pipefail
cat <<YAML
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: rb-worker
  labels:
    cloud.googleapis.com/location: ${REGION:-us-central1}
spec:
  template:
    metadata:
      annotations:
        run.googleapis.com/cloudsql-instances: ${ENV_SUB_CONN}
        autoscaling.knative.dev/minScale: "${ENV_SUB_WMIN}"
        autoscaling.knative.dev/maxScale: "${ENV_SUB_WMIN}"
        run.googleapis.com/cpu-throttling: "false"
    spec:
      serviceAccountName: rb-worker@${PROJECT}.iam.gserviceaccount.com
      containers:
        - name: worker
          image: ${ENV_SUB_IMG_APP}
          command: ["npm", "run", "start:worker"]
          ports: [{ name: http1, containerPort: 8080 }]
          startupProbe: { httpGet: { path: /healthz, port: 8080 }, initialDelaySeconds: 5, periodSeconds: 10, failureThreshold: 6 }
          livenessProbe: { httpGet: { path: /healthz, port: 8080 }, periodSeconds: 30 }
          env:
            - { name: NODE_ENV, value: "production" }
            - { name: LLM_BASE_URL, value: "http://localhost:4000/v1" }
            - { name: LLM_MODEL, value: "riverbend-extraction" }
            - { name: BUDGET_AUTHORITY, value: "litellm" }
            - { name: RESEND_REPLY_DOMAIN, value: "${RESEND_REPLY_DOMAIN:-riverbend.example}" }
            - { name: HELD_BUDGET_RETRY_SECONDS, value: "60" }
            - { name: ADMIN_BOOTSTRAP_TOKEN, valueFrom: { secretKeyRef: { name: admin-bootstrap-token, key: latest } } }
            - { name: DATABASE_URL, valueFrom: { secretKeyRef: { name: database-url, key: latest } } }
            - { name: DATABASE_ADMIN_URL, valueFrom: { secretKeyRef: { name: database-admin-url, key: latest } } }
            - { name: DATABASE_MIGRATOR_URL, valueFrom: { secretKeyRef: { name: database-migrator-url, key: latest } } }
            - { name: EMAIL_SIGNING_KEY, valueFrom: { secretKeyRef: { name: email-signing-key, key: latest } } }
            - { name: RESEND_API_KEY, valueFrom: { secretKeyRef: { name: resend-api-key, key: latest } } }
            - { name: LLM_API_KEY, valueFrom: { secretKeyRef: { name: litellm-master-key, key: latest } } }
            - { name: LLM_MASTER_KEY, valueFrom: { secretKeyRef: { name: litellm-master-key, key: latest } } }
          resources: { limits: { cpu: "1", memory: 512Mi } }
        - name: litellm
          image: ${ENV_SUB_IMG_LLM}
          startupProbe: { tcpSocket: { port: 4000 }, initialDelaySeconds: 10, periodSeconds: 10, failureThreshold: 18 }
          env:
            - { name: OPENAI_API_KEY, valueFrom: { secretKeyRef: { name: openai-api-key, key: latest } } }
            - { name: LITELLM_MASTER_KEY, valueFrom: { secretKeyRef: { name: litellm-master-key, key: latest } } }
            - { name: DATABASE_URL, valueFrom: { secretKeyRef: { name: litellm-database-url, key: latest } } }
          resources: { limits: { cpu: "1", memory: 1Gi } }
YAML
