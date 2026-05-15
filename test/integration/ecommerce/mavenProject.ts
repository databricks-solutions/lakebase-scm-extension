/**
 * Maven Project Scaffolding
 *
 * Creates a minimal but real Spring Boot + JPA + Flyway project
 * so that ./mvnw flyway:migrate and ./mvnw test actually work.
 */

import * as fs from 'fs';
import * as path from 'path';

const POM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>3.5.5</version>
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>demo</artifactId>
    <version>1.0.0-SNAPSHOT</version>
    <name>E-Commerce Test Project</name>

    <properties>
        <java.version>21</java.version>
        <flyway.version>10.22.0</flyway.version>
        <postgresql.version>42.7.10</postgresql.version>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-data-jpa</artifactId>
        </dependency>
        <dependency>
            <groupId>org.postgresql</groupId>
            <artifactId>postgresql</artifactId>
            <scope>runtime</scope>
        </dependency>
        <dependency>
            <groupId>org.flywaydb</groupId>
            <artifactId>flyway-core</artifactId>
        </dependency>
        <dependency>
            <groupId>org.flywaydb</groupId>
            <artifactId>flyway-database-postgresql</artifactId>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-test</artifactId>
            <scope>test</scope>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.apache.maven.plugins</groupId>
                <artifactId>maven-surefire-plugin</artifactId>
                <configuration>
                    <argLine>--enable-native-access=ALL-UNNAMED -XX:+EnableDynamicAgentLoading</argLine>
                </configuration>
            </plugin>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
            </plugin>
            <plugin>
                <groupId>org.flywaydb</groupId>
                <artifactId>flyway-maven-plugin</artifactId>
                <configuration>
                    <url>\${env.SPRING_DATASOURCE_URL}</url>
                    <user>\${env.SPRING_DATASOURCE_USERNAME}</user>
                    <password>\${env.SPRING_DATASOURCE_PASSWORD}</password>
                    <baselineOnMigrate>true</baselineOnMigrate>
                </configuration>
            </plugin>
        </plugins>
    </build>
</project>
`;

const MAVEN_WRAPPER_PROPERTIES = `distributionUrl=https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.8.6/apache-maven-3.8.6-bin.zip
wrapperUrl=https://repo.maven.apache.org/maven2/org/apache/maven/wrapper/maven-wrapper/3.2.0/maven-wrapper-3.2.0.jar
`;

// Apache Maven Wrapper startup script v3.3.4 (Apache License 2.0)
// Embedded as a constant so the test suite is fully self-contained — no external downloads.
// This script downloads Maven on first run using curl/wget/java, no wrapper JAR needed.
/* eslint-disable no-useless-escape */
const MVNW_SCRIPT = `#!/bin/sh
# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements. See the NOTICE file distributed with
# this work for additional information regarding copyright ownership.
# The ASF licenses this file to you under the Apache License, Version 2.0.
# http://www.apache.org/licenses/LICENSE-2.0
# Apache Maven Wrapper startup batch script, version 3.3.4

set -euf
[ "\${MVNW_VERBOSE-}" != debug ] || set -x

native_path() { printf %s\\\\n "$1"; }
case "$(uname)" in
CYGWIN* | MINGW*)
 [ -z "\${JAVA_HOME-}" ] || JAVA_HOME="$(cygpath --unix "$JAVA_HOME")"
 native_path() { cygpath --path --windows "$1"; }
 ;;
esac

set_java_home() {
 if [ -n "\${JAVA_HOME-}" ]; then
 if [ -x "$JAVA_HOME/jre/sh/java" ]; then
 JAVACMD="$JAVA_HOME/jre/sh/java"
 JAVACCMD="$JAVA_HOME/jre/sh/javac"
 else
 JAVACMD="$JAVA_HOME/bin/java"
 JAVACCMD="$JAVA_HOME/bin/javac"
 if [ ! -x "$JAVACMD" ] || [ ! -x "$JAVACCMD" ]; then
 echo "The JAVA_HOME environment variable is not defined correctly, so mvnw cannot run." >&2
 echo "JAVA_HOME is set to \\"$JAVA_HOME\\", but \\"\\$JAVA_HOME/bin/java\\" or \\"\\$JAVA_HOME/bin/javac\\" does not exist." >&2
 return 1
 fi
 fi
 else
 JAVACMD="$(
 'set' +e
 'unset' -f command 2>/dev/null
 'command' -v java
 )" || :
 JAVACCMD="$(
 'set' +e
 'unset' -f command 2>/dev/null
 'command' -v javac
 )" || :
 if [ ! -x "\${JAVACMD-}" ] || [ ! -x "\${JAVACCMD-}" ]; then
 echo "The java/javac command does not exist in PATH nor is JAVA_HOME set, so mvnw cannot run." >&2
 return 1
 fi
 fi
}

hash_string() {
 str="\${1:-}" h=0
 while [ -n "$str" ]; do
 char="\${str%"\${str#?}"}"
 h=$(((h * 31 + $(LC_CTYPE=C printf %d "'$char")) % 4294967296))
 str="\${str#?}"
 done
 printf %x\\\\n $h
}

verbose() { :; }
[ "\${MVNW_VERBOSE-}" != true ] || verbose() { printf %s\\\\n "\${1-}"; }

die() {
 printf %s\\\\n "$1" >&2
 exit 1
}

trim() {
 printf "%s" "\${1}" | tr -d '[:space:]'
}

scriptDir="$(dirname "$0")"
scriptName="$(basename "$0")"

while IFS="=" read -r key value; do
 case "\${key-}" in
 distributionUrl) distributionUrl=$(trim "\${value-}") ;;
 distributionSha256Sum) distributionSha256Sum=$(trim "\${value-}") ;;
 esac
done <"$scriptDir/.mvn/wrapper/maven-wrapper.properties"
[ -n "\${distributionUrl-}" ] || die "cannot read distributionUrl property in $scriptDir/.mvn/wrapper/maven-wrapper.properties"

case "\${distributionUrl##*/}" in
maven-mvnd-*bin.*)
 MVN_CMD=mvnd.sh _MVNW_REPO_PATTERN=/maven/mvnd/
 case "\${PROCESSOR_ARCHITECTURE-}\${PROCESSOR_ARCHITEW6432-}:$(uname -a)" in
 *AMD64:CYGWIN* | *AMD64:MINGW*) distributionPlatform=windows-amd64 ;;
 :Darwin*x86_64) distributionPlatform=darwin-amd64 ;;
 :Darwin*arm64) distributionPlatform=darwin-aarch64 ;;
 :Linux*x86_64*) distributionPlatform=linux-amd64 ;;
 *)
 echo "Cannot detect native platform for mvnd on $(uname)-$(uname -m), use pure java version" >&2
 distributionPlatform=linux-amd64
 ;;
 esac
 distributionUrl="\${distributionUrl%-bin.*}-$distributionPlatform.zip"
 ;;
maven-mvnd-*) MVN_CMD=mvnd.sh _MVNW_REPO_PATTERN=/maven/mvnd/ ;;
*) MVN_CMD="mvn\${scriptName#mvnw}" _MVNW_REPO_PATTERN=/org/apache/maven/ ;;
esac

[ -z "\${MVNW_REPOURL-}" ] || distributionUrl="$MVNW_REPOURL$_MVNW_REPO_PATTERN\${distributionUrl#*"$_MVNW_REPO_PATTERN"}"
distributionUrlName="\${distributionUrl##*/}"
distributionUrlNameMain="\${distributionUrlName%.*}"
distributionUrlNameMain="\${distributionUrlNameMain%-bin}"
MAVEN_USER_HOME="\${MAVEN_USER_HOME:-\${HOME}/.m2}"
MAVEN_HOME="\${MAVEN_USER_HOME}/wrapper/dists/\${distributionUrlNameMain-}/$(hash_string "$distributionUrl")"

exec_maven() {
 unset MVNW_VERBOSE MVNW_USERNAME MVNW_PASSWORD MVNW_REPOURL || :
 exec "$MAVEN_HOME/bin/$MVN_CMD" "$@" || die "cannot exec $MAVEN_HOME/bin/$MVN_CMD"
}

if [ -d "$MAVEN_HOME" ]; then
 verbose "found existing MAVEN_HOME at $MAVEN_HOME"
 exec_maven "$@"
fi

case "\${distributionUrl-}" in
*?-bin.zip | *?maven-mvnd-?*-?*.zip) ;;
*) die "distributionUrl is not valid, must match *-bin.zip or maven-mvnd-*.zip, but found '\${distributionUrl-}'" ;;
esac

if TMP_DOWNLOAD_DIR="$(mktemp -d)" && [ -d "$TMP_DOWNLOAD_DIR" ]; then
 clean() { rm -rf -- "$TMP_DOWNLOAD_DIR"; }
 trap clean HUP INT TERM EXIT
else
 die "cannot create temp dir"
fi

mkdir -p -- "\${MAVEN_HOME%/*}"

verbose "Couldn't find MAVEN_HOME, downloading and installing it ..."
verbose "Downloading from: $distributionUrl"
verbose "Downloading to: $TMP_DOWNLOAD_DIR/$distributionUrlName"

if ! command -v unzip >/dev/null; then
 distributionUrl="\${distributionUrl%.zip}.tar.gz"
 distributionUrlName="\${distributionUrl##*/}"
fi

__MVNW_QUIET_WGET=--quiet __MVNW_QUIET_CURL=--silent __MVNW_QUIET_UNZIP=-q __MVNW_QUIET_TAR=''
[ "\${MVNW_VERBOSE-}" != true ] || __MVNW_QUIET_WGET='' __MVNW_QUIET_CURL='' __MVNW_QUIET_UNZIP='' __MVNW_QUIET_TAR=v

case "\${MVNW_PASSWORD:+has-password}" in
'') MVNW_USERNAME='' MVNW_PASSWORD='' ;;
has-password) [ -n "\${MVNW_USERNAME-}" ] || MVNW_USERNAME='' MVNW_PASSWORD='' ;;
esac

if [ -z "\${MVNW_USERNAME-}" ] && command -v wget >/dev/null; then
 verbose "Found wget ... using wget"
 wget \${__MVNW_QUIET_WGET:+"$__MVNW_QUIET_WGET"} "$distributionUrl" -O "$TMP_DOWNLOAD_DIR/$distributionUrlName" || die "wget: Failed to fetch $distributionUrl"
elif [ -z "\${MVNW_USERNAME-}" ] && command -v curl >/dev/null; then
 verbose "Found curl ... using curl"
 curl \${__MVNW_QUIET_CURL:+"$__MVNW_QUIET_CURL"} -f -L -o "$TMP_DOWNLOAD_DIR/$distributionUrlName" "$distributionUrl" || die "curl: Failed to fetch $distributionUrl"
elif set_java_home; then
 verbose "Falling back to use Java to download"
 javaSource="$TMP_DOWNLOAD_DIR/Downloader.java"
 targetZip="$TMP_DOWNLOAD_DIR/$distributionUrlName"
 cat >"$javaSource" <<-END
 public class Downloader extends java.net.Authenticator
 {
 protected java.net.PasswordAuthentication getPasswordAuthentication()
 {
 return new java.net.PasswordAuthentication( System.getenv( "MVNW_USERNAME" ), System.getenv( "MVNW_PASSWORD" ).toCharArray() );
 }
 public static void main( String[] args ) throws Exception
 {
 setDefault( new Downloader() );
 java.nio.file.Files.copy( java.net.URI.create( args[0] ).toURL().openStream(), java.nio.file.Paths.get( args[1] ).toAbsolutePath().normalize() );
 }
 }
END
 verbose " - Compiling Downloader.java ..."
 "$(native_path "$JAVACCMD")" "$(native_path "$javaSource")" || die "Failed to compile Downloader.java"
 verbose " - Running Downloader.java ..."
 "$(native_path "$JAVACMD")" -cp "$(native_path "$TMP_DOWNLOAD_DIR")" Downloader "$distributionUrl" "$(native_path "$targetZip")"
fi

if [ -n "\${distributionSha256Sum-}" ]; then
 distributionSha256Result=false
 if [ "$MVN_CMD" = mvnd.sh ]; then
 echo "Checksum validation is not supported for maven-mvnd." >&2
 exit 1
 elif command -v sha256sum >/dev/null; then
 if echo "$distributionSha256Sum $TMP_DOWNLOAD_DIR/$distributionUrlName" | sha256sum -c - >/dev/null 2>&1; then
 distributionSha256Result=true
 fi
 elif command -v shasum >/dev/null; then
 if echo "$distributionSha256Sum $TMP_DOWNLOAD_DIR/$distributionUrlName" | shasum -a 256 -c >/dev/null 2>&1; then
 distributionSha256Result=true
 fi
 else
 echo "Checksum validation was requested but neither 'sha256sum' or 'shasum' are available." >&2
 exit 1
 fi
 if [ $distributionSha256Result = false ]; then
 echo "Error: Failed to validate Maven distribution SHA-256, your Maven distribution might be compromised." >&2
 exit 1
 fi
fi

if command -v unzip >/dev/null; then
 unzip \${__MVNW_QUIET_UNZIP:+"$__MVNW_QUIET_UNZIP"} "$TMP_DOWNLOAD_DIR/$distributionUrlName" -d "$TMP_DOWNLOAD_DIR" || die "failed to unzip"
else
 tar xzf\${__MVNW_QUIET_TAR:+"$__MVNW_QUIET_TAR"} "$TMP_DOWNLOAD_DIR/$distributionUrlName" -C "$TMP_DOWNLOAD_DIR" || die "failed to untar"
fi

actualDistributionDir=""
if [ -d "$TMP_DOWNLOAD_DIR/$distributionUrlNameMain" ]; then
 if [ -f "$TMP_DOWNLOAD_DIR/$distributionUrlNameMain/bin/$MVN_CMD" ]; then
 actualDistributionDir="$distributionUrlNameMain"
 fi
fi
if [ -z "$actualDistributionDir" ]; then
 set +f
 for dir in "$TMP_DOWNLOAD_DIR"/*; do
 if [ -d "$dir" ]; then
 if [ -f "$dir/bin/$MVN_CMD" ]; then
 actualDistributionDir="$(basename "$dir")"
 break
 fi
 fi
 done
 set -f
fi
[ -n "$actualDistributionDir" ] || die "Could not find Maven distribution directory in extracted archive"

printf %s\\\\n "$distributionUrl" >"$TMP_DOWNLOAD_DIR/$actualDistributionDir/mvnw.url"
mv -- "$TMP_DOWNLOAD_DIR/$actualDistributionDir" "$MAVEN_HOME" || [ -d "$MAVEN_HOME" ] || die "fail to move MAVEN_HOME"

clean || :
exec_maven "$@"
`;
/* eslint-enable no-useless-escape */

const APPLICATION_PROPERTIES = `# Datasource: set via SPRING_DATASOURCE_URL/USERNAME/PASSWORD env vars
spring.datasource.url=\${SPRING_DATASOURCE_URL:}
spring.datasource.username=\${SPRING_DATASOURCE_USERNAME:}
spring.datasource.password=\${SPRING_DATASOURCE_PASSWORD:}
spring.datasource.driver-class-name=org.postgresql.Driver

# JPA: Flyway owns schema; no runtime DDL
spring.jpa.hibernate.ddl-auto=validate
spring.jpa.properties.hibernate.dialect=org.hibernate.dialect.PostgreSQLDialect
spring.jpa.open-in-view=false

# Flyway
spring.flyway.enabled=true
spring.flyway.locations=classpath:db/migration
spring.flyway.baseline-on-migrate=true

# Connection pool
spring.datasource.hikari.connection-timeout=20000
spring.datasource.hikari.maximum-pool-size=5
`;

const DEMO_APPLICATION_JAVA = `package com.example.demo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class DemoApplication {
    public static void main(String[] args) {
        SpringApplication.run(DemoApplication.class, args);
    }
}
`;

const DEMO_APPLICATION_TESTS_JAVA = `package com.example.demo;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;

@SpringBootTest
class DemoApplicationTests {
    @Test
    void contextLoads() {}
}
`;

function writeFile(projectDir: string, relativePath: string, content: string): void {
  const fullPath = path.join(projectDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

/**
 * Scaffold a minimal Maven/Spring Boot project so ./mvnw flyway:migrate works.
 * Call this after ProjectCreationService.createProject() and before starting the runner.
 */
export function scaffoldMavenProject(projectDir: string): void {
  console.log('    [maven] Scaffolding Maven project...');

  // pom.xml
  writeFile(projectDir, 'pom.xml', POM_XML);

  // .mvn/wrapper/maven-wrapper.properties
  writeFile(projectDir, '.mvn/wrapper/maven-wrapper.properties', MAVEN_WRAPPER_PROPERTIES);

  // mvnw — copy from the extension's template directory (not embedded, avoids escape issues)
  const mvnwPath = path.join(projectDir, 'mvnw');
  const templateMvnw = path.join(__dirname, '../../../templates/project/java/mvnw');
  if (fs.existsSync(templateMvnw)) {
    fs.copyFileSync(templateMvnw, mvnwPath);
  } else {
    // Fallback: use embedded constant (for environments without template dir)
    fs.writeFileSync(mvnwPath, MVNW_SCRIPT);
  }
  fs.chmodSync(mvnwPath, 0o755);

  // application.properties
  writeFile(projectDir, 'src/main/resources/application.properties', APPLICATION_PROPERTIES);

  // DemoApplication.java
  writeFile(projectDir, 'src/main/java/com/example/demo/DemoApplication.java', DEMO_APPLICATION_JAVA);

  // DemoApplicationTests.java
  writeFile(projectDir, 'src/test/java/com/example/demo/DemoApplicationTests.java', DEMO_APPLICATION_TESTS_JAVA);

  // Workflow patching for self-hosted runners is now handled by ScaffoldService.patchWorkflowsForRunnerType()
  // which is called by scaffoldAll() in ProjectCreationService. No separate patching needed here.

  console.log('    [maven] Maven project scaffolded (pom.xml, mvnw, application.properties, DemoApplication.java).');
}
