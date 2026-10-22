-libaries:
SpringApplication. autoconfigure.SpringBootApplication
Usage: tomcat, server ramp up .
Web.bind.annotation
Usage: 
jdbc.core.


## Schema:
One schema, for articles of data, served by two dtos PageDataDto, Article.

### article, working in tandem with pagedatadto.
For an article' s cover and position. The fields 
reflect this and mostly align with home_page(mariadb table)'s  
Pagedatadto is a packaing of all the articles. 

## Helpers:
queryArticles
    
    jdbc helper. forms the slug and
