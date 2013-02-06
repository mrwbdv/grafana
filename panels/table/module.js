angular.module('kibana.table', [])
.controller('table', function($scope, $rootScope, $location) {

  var _id = _.uniqueId();

  // Set and populate defaults
  var _d = {
    query   : "*",
    size    : 100,
    sort    : ['@timestamp','desc'],
    group   : "default",
    style   : {},
    fields  : [],
  }
  _.defaults($scope.panel,_d)

  $scope.init = function () {
    $scope.$on(_id+"-time", function(event,time){set_time(time)});
    $scope.$on($scope.panel.group+"-time", function(event,time){set_time(time)});
    $scope.$on($scope.panel.group+"-query", function(event, query) {
      console.log($scope.panel)
      $scope.panel.query = query;
      $scope.get_data();
    });
    $scope.$on($scope.panel.group+"-sort", function(event,sort){
      $scope.panel.sort = _.clone(sort);
    });
    $scope.$on($scope.panel.group+"-selected_fields", function(event, fields) {
      $scope.panel.fields = _.clone(fields)
    });

    $scope.$watch(function() {
      return angular.toJson($scope.panel.sort)
    }, function(){$scope.get_data()});
    // Now that we're all setup, request the time from our group
    $rootScope.$broadcast($scope.panel.group+"-get_time",_id)
  }

  $scope.set_sort = function(field) {
    if($scope.panel.sort[0] === field)
      $scope.panel.sort[1] = $scope.panel.sort[1] == 'asc' ? 'desc' : 'asc';
    else
      $scope.panel.sort[0] = field;
  }

  $scope.get_data = function() {
    // Make sure we have everything for the request to complete
    if(_.isUndefined($scope.panel.index) || _.isUndefined($scope.panel.time))
      return

    var request = $scope.ejs.Request().indices($scope.panel.index);

    var results = request
      .query(ejs.FilteredQuery(
        ejs.QueryStringQuery($scope.panel.query || '*'),
        ejs.RangeFilter(config.timefield)
          .from($scope.panel.time.from)
          .to($scope.panel.time.to)
        )
      )
      .size($scope.panel.size)
      .sort($scope.panel.sort[0],$scope.panel.sort[1])
      .doSearch();

    // Populate scope when we have results
    results.then(function(results) {
      if(_.isUndefined(results)) {
        $scope.panel.error = 'Your query was unsuccessful';
        return;
      }
      $scope.panel.error =  false;
      $scope.hits = results.hits.total;
      $scope.data = results.hits.hits;

      // Broadcast a list of all fields. Note that receivers of field array 
      // events should be able to receive from multiple sources, merge, dedupe 
      // and sort on the fly.
      if (!(_.isUndefined($scope.panel.group)))
        $rootScope.$broadcast(
          $scope.panel.group+"-fields", {
            all   : get_all_fields(results),
            sort  : $scope.panel.sort,
            active: $scope.panel.fields
          });  
    });
  }

  $scope.move_field = function(field,dir) {
    console.log(field,dir)
  }

  function set_time(time) {
    $scope.panel.time = time;
    $scope.panel.index = _.isUndefined(time.index) ? $scope.panel.index : time.index
    $scope.get_data();
  }

  $scope.init();

});