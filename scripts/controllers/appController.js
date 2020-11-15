paysharesExplorer.controller('appController', function($scope, $q, requestHelper, federation, reverseFederation) {
  var websocketProtocol = location.protocol == 'https:' ? 'wss:' : 'ws:';

  $scope.testConfig = {
    network: websocketProtocol + '//test.payshares.org:9001',
    domain: 'stg.payshares.org'
  };

  $scope.liveConfig = {
    network: websocketProtocol + '//one.validator.payshares.org:5016',
    domain: 'payshares.org'
  };

  var connection = null;

  $scope.reset = function() {
    $scope.config = $scope.liveConfig;

    updateQueryFromHash(true);

    $scope.queryValid = true;
    $scope.emptyQuery = true;
    $scope.lastQuery = '';
    $scope.address = '';

    $scope.account_info = null;
    $scope.account_offers = [];
    $scope.account_lines = [];
    $scope.trustGiven = [];
    $scope.trustReceived = [];

    $scope.balances = {};
    $scope.balanceCurrencies = [];
    $scope.transactions = [];

    connect();
  }

  function updateQueryFromHash(initialUpdate) {
    // Make sure that we don't have to do any work if we don't have to
    if ((
         // Continue if we are not changing networks
         (location.hash.substr(0,2) == '#/' && $scope.config == $scope.liveConfig) ||
         (location.hash.substr(0,6) == '#test/' && $scope.config == $scope.testConfig) ||
         (location.hash.substr(0,6) == '#live/' && $scope.config == $scope.liveConfig)
        )
        && (location.hash == '#/' + $scope.query ||
            location.hash == '#test/' + $scope.query ||
            location.hash == '#live/' + $scope.query)) {
      return;
    }

    if (location.hash == '#/') {
      $scope.query = '';
    } else if (location.hash.substr(0,2) == '#/') {
      $scope.query = location.hash.substr(2);
      setTimeout(function() {$scope.useLiveConfig();}, 0); // This error comes up without setTimeout: TypeError: Cannot read property 'close' of null
    } else if (location.hash.substr(0,6) == '#test/') {
      $scope.query = location.hash.substr(6);
      setTimeout(function() {$scope.useTestConfig();}, 0);
    } else if (location.hash.substr(0,6) == '#live/') {
      $scope.query = location.hash.substr(6);
      setTimeout(function() {$scope.useLiveConfig();}, 0);
    } else {
      $scope.query = '';
    }

    if (initialUpdate !== true) {
      $scope.updateAccountData();
    }
  }

  $scope.useTestConfig = function() {
    if ($scope.config == $scope.testConfig) return;
    $scope.config = $scope.testConfig;
    $scope.updateHash(false); // #/address
    connection.close();
  };

  $scope.useLiveConfig = function() {
    if ($scope.config == $scope.liveConfig) return;
    $scope.config = $scope.liveConfig;
    $scope.updateHash(false); // #live/address
    connection.close();
  };

  function connect() {
    $scope.transactions = [];
    $scope.loading = true;

    connection = new WebSocket($scope.config.network);

    connection.onopen = function() {
      requestHelper.useConnection(connection);

      $scope.$apply(function() {
        $scope.updateAccountData(true, true);
      });
    };

    connection.onclose = function() {
      $scope.$apply(connect);
    };
  }

  requestHelper.setDefaultCallback(handleMessage);


  // TODO: extract message handling to service
  // IDEA: Custom event emitter Service (Pub/Sub)
  function handleMessage (message) {
    if(message.engine_result_code !== 0) return; // If the transaction did not succeed let's bounce!

    // Message contains one or more transactions in an array
    // Find a transaction transaction belongs to the current user
    var affectedNode = _.find(message.meta.AffectedNodes, function (node) {
      // Check if the the current user is the destination of this transaction
      if (typeof node.ModifiedNode !== 'undefined' &&
          typeof node.ModifiedNode.FinalFields !== 'undefined' &&
          typeof node.ModifiedNode.FinalFields.Account !== 'undefined') {
        return node.ModifiedNode.FinalFields.Account == $scope.address;
      }
      return false;
    });

    if (typeof affectedNode === 'undefined') {
      // No relevant transactions to current user
      return;
    }

    _.extend($scope.account_info, affectedNode.ModifiedNode.FinalFields);

    switch(message.type){
      case 'transaction':
        // IDEA: Service.emit transaction event
        // IDEA: Service.subscribe('transaction', handleTransaction);
        handleTransaction(message.transaction);
        break;
      default:
        $scope.requestAccountData(true);
        break;
    }
  }

  function handleTransaction(transaction){
    // If the transaction amount it's only a number they are microstellars.
    if(!isNaN(transaction.Amount)){
      transaction.Amount = {
        currency: 'STR',
        value: dustToStellars(transaction.Amount) // Convert to stellars
      };
    }

    // API BUG: Sometimes you get the transaction 2 times instead of just one.
    // FIX: We check if there is a transaction exactly like this one.
    if(_.find($scope.transactions, transaction)) return;


    // We check if the account we are watching is part of the transaction
    switch($scope.address){
      case transaction.Account: // Current Query is the account of the transaction
        break;
      case transaction.Destination: // Current Query is the destination of the transaction
        break;
      default:
        // If the account we are watching isn't part of the transaction ignore it.
        return;
    }
    $scope.transactions.push(transaction);
    $scope.$apply(aggregateBalances);
  }

  $scope.queryAddress = function(address) {
    $scope.query = address;
    $scope.updateAccountData();
  };

  $scope.updateHash = function(initialUpdate) {
    if (!initialUpdate) {
      if ($scope.config == $scope.liveConfig) {
        location.hash = '#live/' + $scope.query;
      } else {
        location.hash = '#test/' + $scope.query;
      }
    }
  }

  $scope.updateAccountData = function(silent, initialUpdate) {
    if (!silent) {
      $scope.loading = true;

      // HACK: Reset these references to prevent highlighing values when rendering a new account.
      $scope.account_info = null;
      $scope.account_lines = [];
      $scope.trustGiven = [];
      $scope.trustReceived = [];
      $scope.account_offers = [];
      $scope.balances = {};
      $scope.balanceCurrencies = [];
    }

    if (initialUpdate && $scope.query == '') { // Don't fetch a blank account if the page is being loaded with a blank account
      $scope.loading = false;
      $scope.queryValid = false;
      return;
    }
    $scope.transactions = []; // Clear incoming transactions

    $scope.emptyQuery = false; // Make result visible

    $scope.updateHash(initialUpdate);
    
    requestHelper.unsubscribeTransactions($scope.address);

    resolveQuery().then(function() { $scope.requestAccountData(silent); });

    requestHelper.subscribeTransactions($scope.address); 

    
  }

  $scope.requestAccountData = function() {
    requestHelper.getAccountInfo($scope.address, function(info) {
      $scope.account_info = info;
    })
      .then(function() {
        return requestHelper.getAccountLines($scope.address, function(lines) {
          for(i = 0; i < lines.length; i++) {
            if(lines[i].limit > 0) $scope.trustGiven.push(lines[i]);
            if(lines[i].limit_peer > 0) $scope.trustReceived.push(lines[i]);
          }
          $scope.account_lines = lines;
        });
      })
      .then(function() {
        return requestHelper.getAccountOffers($scope.address, function(offers) {
          $scope.account_offers = offers;
        });
      })
      .then(aggregateBalances)
      .finally(function() {
        $scope.loading = false;
        $scope.apply();
      });
  };

  function resolveQuery() {
    var deferred = $q.defer();

    $scope.lastQuery = $scope.query;
    $scope.queryValid = true;

    var validAddress = false;

    try {
      validAddress = !!base58.base58Check.decode($scope.query);
    } catch (e) {}

    if (validAddress) {
      $scope.address = $scope.query;

      reverseFederation.check_address($scope.address, $scope.config.domain)
        .then(function (result) {
          $scope.lastQuery = result.destination + '@' + result.domain;
          deferred.resolve();
        },
        function () {
          deferred.resolve();
        });
    } else {
      federation.check_email($scope.query, $scope.config.domain)
        .then(function (result) {
          $scope.lastQuery = result.destination + '@' + result.domain;
          $scope.address = result.destination_address;
          deferred.resolve();
        },
        function () {
          $scope.queryValid = false;
          $scope.address = '';
          deferred.reject();
        });
    }

    return deferred.promise;
  }

  function aggregateBalances() {
    $scope.balances = {'STR': 0};
    $scope.balanceCurrencies = ['STR'];

    if (!$scope.account_info) return;

    $scope.balances['STR'] = +dustToStellars($scope.account_info.Balance);

    $scope.account_lines.forEach(function(line) {
      $scope.balances[line.currency] = ($scope.balances[line.currency] || 0) + (+line.balance);
    });

    $scope.balanceCurrencies = Object.getOwnPropertyNames($scope.balances);
  }

  $scope.reset();

  window.addEventListener("hashchange", function() {
    updateQueryFromHash();
  }, false);
});
