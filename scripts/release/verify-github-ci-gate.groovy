import groovy.json.JsonSlurperClassic

class GithubCiGateVerifier implements Serializable {
  private static final String REQUIRED_NAME = 'CI gate'
  private static final String REQUIRED_APP_SLUG = 'github-actions'
  private static final long REQUIRED_APP_ID = 15368L
  private static final int MAX_CHECK_RUNS = 100
  private static final String TIMESTAMP = /20[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z/
  private static final List COMPLETED_CONCLUSIONS = [
    'action_required', 'cancelled', 'failure', 'neutral', 'success',
    'skipped', 'stale', 'startup_failure', 'timed_out'
  ]

  boolean isSuccessful(String payload, String targetSha) {
    if (!(targetSha ==~ /[0-9a-f]{40}/) || payload == null || payload.length() == 0) {
      return false
    }

    try {
      def root = new JsonSlurperClassic().parseText(payload)
      if (!(root instanceof Map) || !isInteger(root.total_count) || !(root.check_runs instanceof List)) {
        return false
      }

      def runs = root.check_runs
      long totalCount = root.total_count.longValue()
      if (totalCount < 0 || totalCount > MAX_CHECK_RUNS || totalCount != runs.size()) {
        return false
      }

      def relevant = []
      def seenIds = [] as Set
      for (def run : runs) {
        if (!(run instanceof Map)) {
          return false
        }
        if (run.name != REQUIRED_NAME) {
          continue
        }
        if (run.head_sha != targetSha || !isInteger(run.id) || run.id.longValue() <= 0) {
          return false
        }
        long id = run.id.longValue()
        if (!seenIds.add(id)) {
          return false
        }
        if (!(run.app instanceof Map) || run.app.slug != REQUIRED_APP_SLUG ||
            !isInteger(run.app.id) || run.app.id.longValue() != REQUIRED_APP_ID) {
          return false
        }
        if (!isTimestamp(run.started_at) || !(run.status instanceof String)) {
          return false
        }
        if (run.status == 'completed') {
          if (!(run.conclusion instanceof String) || !COMPLETED_CONCLUSIONS.contains(run.conclusion) ||
              !isTimestamp(run.completed_at) || run.completed_at.compareTo(run.started_at) < 0) {
            return false
          }
        } else if (['queued', 'in_progress', 'pending', 'waiting', 'requested'].contains(run.status)) {
          if (run.conclusion != null || run.completed_at != null) {
            return false
          }
        } else {
          return false
        }
        relevant.add(run)
      }

      if (relevant.isEmpty()) {
        return false
      }
      def latest = relevant.max { left, right ->
        int timestampOrder = left.started_at.compareTo(right.started_at)
        timestampOrder != 0 ? timestampOrder : left.id.longValue().compareTo(right.id.longValue())
      }
      return latest.status == 'completed' && latest.conclusion == 'success'
    } catch (Exception ignored) {
      return false
    }
  }

  private static boolean isInteger(def value) {
    value instanceof Byte || value instanceof Short || value instanceof Integer ||
      value instanceof Long || value instanceof BigInteger
  }

  private static boolean isTimestamp(def value) {
    if (!(value instanceof String) || !(value ==~ TIMESTAMP)) {
      return false
    }
    int year = Integer.parseInt(value.substring(0, 4))
    int month = Integer.parseInt(value.substring(5, 7))
    int day = Integer.parseInt(value.substring(8, 10))
    int[] monthDays = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    return day <= monthDays[month - 1]
  }

  private static boolean isLeapYear(int year) {
    year % 400 == 0 || (year % 4 == 0 && year % 100 != 0)
  }
}

return new GithubCiGateVerifier()
