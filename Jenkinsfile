@Library('platform-core') _

pipeline {
    agent {
        kubernetes {
            inheritFrom 'war-table-builder'
            defaultContainer 'builder'
            yamlMergeStrategy merge()
            slaveConnectTimeout 900
        }
    }
    options {
        timestamps()
        disableConcurrentBuilds()
        skipDefaultCheckout(true)
        timeout(time: 60, unit: 'MINUTES')
    }
    environment {
        PATH = '/opt/war-table-ci/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
    }
    stages {
        stage('Bootstrap Checkout') {
            steps {
                sh 'export DEBIAN_FRONTEND=noninteractive; apt-get update && apt-get install -y --no-install-recommends ca-certificates git'
            }
        }
        stage('Trusted Checkout') {
            steps {
                script {
                    def source = checkout scm
                    env.GIT_BRANCH = source.GIT_BRANCH
                    env.GIT_COMMIT = source.GIT_COMMIT
                }
                sh 'bash ci/trusted-main.sh'
            }
        }
        stage('Prepare Tools') {
            steps { sh 'bash scripts/ci/provision-tools.sh' }
        }
        stage('Validate') {
            steps {
                sh '''#!/bin/bash
set -euo pipefail
npm run check
npm test
npm run check:chart
python3 -m unittest discover -s tests/ci -v
gitleaks git --redact --exit-code 1 .
'''
                platformManagedAppContractValidation(
                    repoPath: '.', validatorPath: 'scripts/validate_managed_app_contract.py',
                    appConfig: '.platform/application.yaml', chartPath: 'deploy/helm/war-table'
                )
            }
        }
        stage('Build, Scan and Sign') {
            steps {
                sh 'bash ci/trusted-main.sh'
                sh 'python3 ci/release.py'
            }
        }
        stage('Archive Verified Release') {
            steps {
                archiveArtifacts artifacts: 'dist/release.json,dist/charts/*.tgz', fingerprint: true
            }
        }
    }
    post {
        always {
            archiveArtifacts artifacts: 'dist/security/**,dist/build-*.json', fingerprint: true, allowEmptyArchive: true
        }
    }
}
