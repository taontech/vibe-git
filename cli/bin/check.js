'use strict';

var colors = require('colors');
var fs = require('fs');

function hasFile(fileName) {
  var readSubDir = process.cwd();
  var path = readSubDir+"/"+fileName;
  // console.log("path:"+readSubDir + "name:"+fileName);
  if(fs.existsSync(path)){
    return true;
  }
  return false;
}

module.exports = {
  checkWidgetFile:function(fileName) {
    var didFound = false;
    if(fileName.split('_').length == 3) {
      // 符合命名规则 TODO 添加复杂判断检查
      // 获取文件名
      var splitName = fileName.split('.');
      splitName.pop();
      var componentName = splitName.join('');
      // console.log("name:::::"+componentName);
      // 检查当前路径下是否有对应的相同命名的json和js文件
      var jsname = componentName+".js";
      var jsonname = componentName+".json";
      if(hasFile(jsname) && hasFile(jsonname)) {
        // console.log("js文件和json文件同时存在！")
        didFound = true;
      }
    }

    return didFound;
  },

  checkAppFile:function(filePath) {
    var didFound = false;
    var dirs = filePath.split('/');
    var fileDir = dirs.pop();
    var readDir = fs.readdirSync(filePath);
    readDir.forEach(function(fileName, index) {
      if (fileName == 'config.json' ) {
           didFound = true;
      }
    });
    return didFound;
  }
};
