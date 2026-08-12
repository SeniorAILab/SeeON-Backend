#!/usr/bin/env groovy
import groovy.json.JsonOutput
import groovy.json.JsonSlurperClassic

if (args.length != 2) {
  System.err.println('Usage: verify-github-ci-gate.fixture.test.groovy <parser> <fixtures>')
  System.exit(2)
}

def verifier = evaluate(new File(args[0]))
def cases = new JsonSlurperClassic().parse(new File(args[1]))
def sha = '0123456789abcdef0123456789abcdef01234567'

cases.each { fixture ->
  def payload = fixture.containsKey('raw') ? fixture.raw : JsonOutput.toJson(fixture.response)
  def actual = verifier.isSuccessful(payload, sha)
  assert actual == fixture.expect : "${fixture.name}: expected ${fixture.expect}, got ${actual}"
}

println "GitHub ci-gate Groovy fixtures passed (${cases.size()} cases)"
