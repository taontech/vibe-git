'use strict';

var http = require('http');
var url = require('url');
var querystring = require('querystring');
var colors = require('colors');

var options = { 
 host: "localhost", 
 port: "8888", 
 method: "DELETE",
 path: "/normal/delete",
}

module.exports = {
  deleteFiles:function(fileDir, filePath, fileName) {
    var posetData = querystring.stringify({"filePath": filePath});

    if (fileName) {
      posetData = querystring.stringify({
        "fileName": fileName,
        "filePath": filePath
      });
    }
    
    options.path = url.parse(options.path).pathname + fileDir + '?' + posetData;
    
    var req = http.request(options, function(res) {
      res.setEncoding('utf8');
      res.on("data", function(chunk) {
        console.log(chunk);
      });
      res.on("end", function(chunk) {
        if (res.statusCode == 200) {
          console.log("删除成功".rainbow);
        }
        else {
          console.log("删除失败".red);
        }
      });
    });

    req.on('error', function(e) {
      console.log('problem with request:'.red + e.message.red);
    });
    
    req.end();
  }
};
