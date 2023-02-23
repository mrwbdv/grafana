import { Subscriber, Observable, Subscription } from 'rxjs';

import { DataQueryRequest, DataQueryResponse, dateTime, TimeRange } from '@grafana/data';
import { LoadingState } from '@grafana/schema';

import { LokiDatasource } from './datasource';
import { getRangeChunks as getLogsRangeChunks } from './logsTimeSplit';
import { getRangeChunks as getMetricRangeChunks } from './metricTimeSplit';
import { combineResponses, isLogsQuery } from './queryUtils';
import { LokiQuery } from './types';

/**
 * Purposely exposing it to support doing tests without needing to update the repo.
 * TODO: remove.
 * Hardcoded to 1 day.
 */
(window as any).lokiChunkDuration = 24 * 60 * 60 * 1000;

export function partitionTimeRange(
  isLogsQuery: boolean,
  originalTimeRange: TimeRange,
  intervalMs: number,
  resolution: number
): TimeRange[] {
  // the `step` value that will be finally sent to Loki is rougly the same as `intervalMs`,
  // but there are some complications.
  // we need to replicate this algo:
  //
  // https://github.com/grafana/grafana/blob/main/pkg/tsdb/loki/step.go#L23

  const start = originalTimeRange.from.toDate().getTime();
  const end = originalTimeRange.to.toDate().getTime();

  const safeStep = Math.ceil((end - start) / 11000);
  const step = Math.max(intervalMs * resolution, safeStep);

  const duration: number = (window as any).lokiChunkDuration;

  const ranges = isLogsQuery
    ? getLogsRangeChunks(start, end, duration)
    : getMetricRangeChunks(start, end, step, duration);

  // if the split was not possible, go with the original range
  if (ranges == null) {
    return [originalTimeRange];
  }

  return ranges.map(([start, end]) => {
    const from = dateTime(start);
    const to = dateTime(end);
    return {
      from,
      to,
      raw: { from, to },
    };
  });
}

/**
 * Based in the state of the current response, if any, adjust target parameters such as `maxLines`.
 * For `maxLines`, we will update it as `maxLines - current amount of lines`.
 * At the end, we will filter the targets that don't need to be executed in the next request batch,
 * becasue, for example, the `maxLines` have been reached.
 */

function adjustTargetsFromResponseState(targets: LokiQuery[], response: DataQueryResponse | null): LokiQuery[] {
  if (!response) {
    return targets;
  }

  return targets
    .map((target) => {
      if (!target.maxLines || !isLogsQuery(target.expr)) {
        return target;
      }
      const targetFrame = response.data.find((frame) => frame.refId === target.refId);
      if (!targetFrame) {
        return target;
      }
      const updatedMaxLines = target.maxLines - targetFrame.length;
      return {
        ...target,
        maxLines: updatedMaxLines < 0 ? 0 : updatedMaxLines,
      };
    })
    .filter((target) => target.maxLines === undefined || target.maxLines > 0);
}

export function runPartitionedQuery(datasource: LokiDatasource, request: DataQueryRequest<LokiQuery>) {
  let mergedResponse: DataQueryResponse | null;
  const query = request.targets[0];
  const partition = partitionTimeRange(
    isLogsQuery(query.expr),
    request.range,
    request.intervalMs,
    query.resolution ?? 1
  );
  const totalRequests = partition.length;

  let shouldStop = false;
  let subquerySubsciption: Subscription | null = null;
  const runNextRequest = (subscriber: Subscriber<DataQueryResponse>, requestN: number) => {
    if (shouldStop) {
      subscriber.complete();
      return;
    }

    const requestId = `${request.requestId}_${requestN}`;
    const range = partition[requestN - 1];
    const targets = adjustTargetsFromResponseState(request.targets, mergedResponse);

    const done = (response: DataQueryResponse) => {
      response.state = LoadingState.Done;
      subscriber.next(response);
      subscriber.complete();
    };

    const nextRequest = () => {
      mergedResponse = mergedResponse || { data: [] };
      if (requestN > 1) {
        mergedResponse.state = LoadingState.Streaming;
        subscriber.next(mergedResponse);
        runNextRequest(subscriber, requestN - 1);
        return;
      }
      done(mergedResponse);
    };

    if (!targets.length && mergedResponse) {
      done(mergedResponse);
      return;
    }

    subquerySubsciption = datasource.runQuery({ ...request, range, requestId, targets }).subscribe({
      next: (partialResponse) => {
        if (partialResponse.error) {
          subscriber.error(partialResponse.error);
        }
        mergedResponse = combineResponses(mergedResponse, partialResponse);
      },
      complete: () => {
        nextRequest();
      },
      error: (error) => {
        subscriber.error(error);
      },
    });
  };

  const response = new Observable<DataQueryResponse>((subscriber) => {
    runNextRequest(subscriber, totalRequests);
    return () => {
      shouldStop = true;
      if (subquerySubsciption != null) {
        subquerySubsciption.unsubscribe();
      }
    };
  });

  return response;
}

export function runPartitionedQueries(datasource: LokiDatasource, request: DataQueryRequest<LokiQuery>) {
  const logQueries = request.targets.filter((query) => isLogsQuery(query.expr));
  const metricQueries = request.targets.filter((query) => !logQueries.includes(query));

  const queries = [];
  if (logQueries.length) {
    queries.push({
      queries: logQueries,
      partition: partitionTimeRange(true, request.range, request.intervalMs, logQueries[0].resolution ?? 1),
    });
  }
  if (metricQueries.length) {
    queries.push({
      queries: logQueries,
      partition: partitionTimeRange(false, request.range, request.intervalMs, logQueries[0].resolution ?? 1),
    });
  }
  console.log(queries);
  return runPartitionedQuery(datasource, request);
}
