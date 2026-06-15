package com.demo;

@Mapper
public interface UserMapper {
    User selectById(Long id);
}
