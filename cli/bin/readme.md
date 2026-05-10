[![Build Status](https://travis-ci.org/FFATAP/ffpush.svg?branch=master)](https://travis-ci.org/FFATAP/ffpush)
# ffpush
version: **1.0.8**

## 安装
```
 npm install ffpush -g 
```

<!--e<sup>pi</sup>
<u>这个功能也不错</u>-->
##使用说明
> ffpush脚本命令主要用于上传、删除、添加用户、登录及注销相关操作，该脚本主要是第三方或飞凡用于操作相关飞凡的组件。

该脚本包含以下可用的命令

* remove命令
* release命令
* login命令
* logout命令

使用***-h***帮助可以查看整个命令
```
ffpush -h
```
显示如下所示：
![ffpush -h](http://junhg521.github.io/JSSource/ffpush/ffpush.png)


## remove命令
remove用于删除上传至飞凡项目的组件或app，该命令需要提供删除组件的目录及组件名（**如果组件名为空，则删除目录下的所有文件**）。
该命令的使用方式为:

```
ffpush remove widget/FF_PlazaActivityCell
ffpush remove widget/FF_PlazaActivityCell FF_PlazaActivityCell_0.js
ffpush remove widget/FF_PlazaActivityCell FF_PlazaActivityCell_0.js FF_PlazaActivityCell_256.js FF_PlazaActivityCell_279.js
参数解析
widget/FF_PlazaActivityCell 表示删除目录下的所有的文件
FF_PlazaActivityCell_0.js 表示删除目录下指定的单个文件
FF_PlazaActivityCell_0.js FF_PlazaActivityCell_256.js FF_PlazaActivityCell_279.js 表示删除目录下指定的多个文件
```
## release命令
release用于上传组件或app至飞凡项目中，该命令的详细信息可以使用<mark>**ffpush release -h**</mark>查看，<u>其显示效果为</u>

![ffpush relase -h](http://junhg521.github.io/JSSource/ffpush/release.png)

该命令的使用方式为

```
ffpush release -a
ffpush relase -w
参数解释
-a 表示上传的app，上传该app的目录名，必须提供（FF/UF目录名Controller.js）,比如目录名为AppStore，则目录下必须存在FFAppStoreController.js或UFAppStoreController.js的文件才可以上传
-w 表示上传的组件, 上传的组件命名规则必须为(xx_yy_zz)，其中
xx：表示为FF或则UF
yy:表示为目录名
zz：表示为功能名
同时对于组件必须提供相关js和json文件，才可以上传
```
## <del>login命令</del>
## logout命令


 