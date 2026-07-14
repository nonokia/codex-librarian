resource "aws_security_group" "db" {
  name   = "${local.name_prefix}-db"
  vpc_id = module.vpc.vpc_id
  tags   = local.common_tags
}

resource "aws_db_instance" "main" {
  identifier             = "${local.name_prefix}-db"
  engine                 = "postgres"
  instance_class         = "db.t3.micro"
  allocated_storage      = 20
  username               = "taskflow"
  password               = var.db_password
  db_subnet_group_name   = module.vpc.database_subnet_group
  vpc_security_group_ids  = [aws_security_group.db.id]
  skip_final_snapshot    = true
  tags                   = local.common_tags
}
